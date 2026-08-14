/**
 * MCP Server Routes  —  /v1/mcp
 *
 * Exposes Super Agent as a Model Context Protocol (MCP) server so external IDE
 * clients (Kiro, Amazon Q Developer) can discover agents/scopes, hold a
 * conversation with a Super Agent, and retrieve the files it produces.
 *
 * Transport: Streamable HTTP (stateless) — the current MCP standard that Kiro
 * and Amazon Q speak over a single POST endpoint.
 *
 * Authentication: Bearer API key (same api_keys system as openapi.routes.ts /
 * llm-proxy.routes.ts). The key maps the request to an organization_id, which
 * is passed into every backing service call so tenant isolation holds.
 * Required scope: mcp:tools.
 *
 * Design: document/mcp-server-design.md
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { apiKeyService, type ApiKeyData } from '../services/apiKey.service.js';
import { verifyInternalToken } from '../middleware/auth.js';
import { AppError } from '../middleware/errorHandler.js';
import { chatService } from '../services/chat.service.js';
import { businessScopeService } from '../services/businessScope.service.js';
import { agentService } from '../services/agent.service.js';
import { workspaceManager } from '../services/workspace-manager.js';
import type { ContentBlock } from '../services/claude-agent.service.js';

// ============================================================================
// Auth context resolved from the bearer key (attached to the MCP request)
// ============================================================================

interface McpAuthContext {
  organizationId: string;
  userId: string;
  scopes: string[];
}

const REQUIRED_SCOPE = 'mcp:tools';

/**
 * Resolve and authorize the bearer API key (or internal service token).
 * Mirrors the apiKeyAuth pattern in llm-proxy.routes.ts.
 */
async function resolveAuth(request: FastifyRequest): Promise<McpAuthContext> {
  const authHeader = request.headers.authorization;
  const xApiKey = request.headers['x-api-key'] as string | undefined;

  let apiKey: string | undefined;
  if (authHeader?.startsWith('Bearer ')) {
    apiKey = authHeader.substring(7);
  } else if (xApiKey) {
    apiKey = xApiKey;
  }
  if (!apiKey) {
    throw AppError.unauthorized('Missing or invalid API key');
  }

  // Internal service token (parity with the LLM proxy) — grants all scopes for
  // its org. External IDEs use real keys; this is for internal callers.
  if (apiKey.startsWith('internal.')) {
    const internal = verifyInternalToken(apiKey);
    if (!internal) {
      throw AppError.unauthorized('Invalid or expired internal token');
    }
    return { organizationId: internal.orgId, userId: internal.sub, scopes: [REQUIRED_SCOPE] };
  }

  const keyData: ApiKeyData | null = await apiKeyService.validateApiKey(apiKey);
  if (!keyData) {
    throw AppError.unauthorized('Invalid or expired API key');
  }

  // Rate limit (per-minute, same as the proxy).
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  const withinLimit = await apiKeyService.checkRateLimit(keyHash, keyData.rateLimitPerMinute);
  if (!withinLimit) {
    throw AppError.tooManyRequests('Rate limit exceeded');
  }

  if (!keyData.scopes.includes(REQUIRED_SCOPE)) {
    throw AppError.forbidden(`API key is missing the required scope "${REQUIRED_SCOPE}"`);
  }

  return { organizationId: keyData.organizationId, userId: keyData.userId, scopes: keyData.scopes };
}

// ============================================================================
// Async chat jobs — bridge streaming agent runs to request/response MCP tools.
//
// `chat` starts chatService.processMessage (which blocks until the agent run
// finishes) as a background job keyed by sessionId, and races it against a soft
// deadline. Short runs return the reply inline; long runs return status
// "running" and the client polls chat_result. Jobs are in-memory and best
// -effort — a process restart drops in-flight jobs (the run's result is still
// persisted to chat history, retrievable via the normal history API).
// ============================================================================

interface ChatJob {
  sessionId: string;
  status: 'running' | 'completed' | 'error';
  reply?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const chatJobs = new Map<string, ChatJob>();
const CHAT_BLOCK_MS = Number(process.env.MCP_CHAT_BLOCK_MS ?? 75_000);
const JOB_TTL_MS = 30 * 60_000; // reap finished jobs after 30 min

function reapJobs(): void {
  const now = Date.now();
  for (const [id, job] of chatJobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) chatJobs.delete(id);
  }
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Start (or continue) a chat run in the background and return the job. If a job
 * for this session is already running, return it (the client should poll).
 *
 * For a NEW conversation we pre-create the chat session so the job is keyed by
 * the real session UUID from the start — otherwise a long first turn would have
 * to return a placeholder id the client can't poll with (chat_result validates
 * a UUID). The pre-created id is also passed to processMessage, which resumes
 * that exact session.
 */
async function startChatJob(
  auth: McpAuthContext,
  opts: { message: string; scopeId?: string; agentId?: string; sessionId?: string },
): Promise<ChatJob> {
  reapJobs();

  if (opts.sessionId) {
    const existing = chatJobs.get(opts.sessionId);
    if (existing && existing.status === 'running') return existing;
  }

  // Resolve a real session id up front (create one for a new conversation).
  let sessionId = opts.sessionId;
  if (!sessionId) {
    const created = await chatService.createSession(
      { business_scope_id: opts.scopeId ?? null, agent_id: opts.agentId ?? null, context: {} },
      auth.organizationId,
      auth.userId,
    );
    sessionId = created.id;
  }

  const job: ChatJob = { sessionId, status: 'running', startedAt: Date.now() };
  chatJobs.set(sessionId, job);

  void chatService
    .processMessage({
      sessionId,
      businessScopeId: opts.scopeId,
      agentId: opts.agentId,
      message: opts.message,
      organizationId: auth.organizationId,
      userId: auth.userId,
    })
    .then((result) => {
      job.status = 'completed';
      job.reply = result.text || textFromBlocks(result.contentBlocks) || '(No response)';
      job.finishedAt = Date.now();
    })
    .catch((err) => {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    });

  return job;
}

/** Wait for a job to finish or the soft deadline to elapse. */
async function waitForJob(job: ChatJob, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (job.status === 'running' && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ============================================================================
// MCP server + tools
// ============================================================================

function buildMcpServer(auth: McpAuthContext): McpServer {
  const server = new McpServer({ name: 'super-agent', version: '1.0.0' });

  // ---- list_scopes -------------------------------------------------------
  server.registerTool(
    'list_scopes',
    {
      description:
        'List the business scopes (agent workspaces) available in this organization. ' +
        'Use a scope id with the chat tool to talk to that scope, or with list_agents to see its agents.',
      inputSchema: {},
    },
    async () => {
      const result = await businessScopeService.getBusinessScopes(auth.organizationId, undefined, {
        page: 1,
        limit: 100,
      });
      const scopes = result.data.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? null,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(scopes, null, 2) }] };
    },
  );

  // ---- list_agents -------------------------------------------------------
  server.registerTool(
    'list_agents',
    {
      description:
        'List agents in this organization, optionally filtered by scope_id. ' +
        'Use an agent id with the chat tool to talk to a specific agent.',
      inputSchema: { scope_id: z.string().uuid().optional() },
    },
    async ({ scope_id }) => {
      const result = await agentService.getAgents(
        auth.organizationId,
        scope_id ? { business_scope_id: scope_id, status: 'active' } : { status: 'active' },
        { page: 1, limit: 100 },
      );
      const agents = result.data.map((a) => ({
        id: a.id,
        name: a.name,
        display_name: a.display_name,
        role: a.role,
        scope_id: a.business_scope_id ?? null,
      }));
      return { content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }] };
    },
  );

  // ---- chat --------------------------------------------------------------
  server.registerTool(
    'chat',
    {
      description:
        'Send a message to a Super Agent and let it complete the work (it may use skills, ' +
        'sub-agents, knowledge-base search, and produce workspace files). Provide scope_id ' +
        '(recommended) or agent_id to choose who you talk to. Pass session_id from a previous ' +
        'reply to continue the same conversation. Short tasks return the reply directly; long ' +
        'tasks return status="running" with a session_id — poll chat_result with that id. ' +
        'Use get_workspace to fetch files the agent produced.',
      inputSchema: {
        message: z.string().min(1),
        scope_id: z.string().uuid().optional(),
        agent_id: z.string().uuid().optional(),
        session_id: z.string().uuid().optional(),
      },
    },
    async ({ message, scope_id, agent_id, session_id }) => {
      if (!scope_id && !agent_id && !session_id) {
        throw new Error('Provide scope_id or agent_id (or session_id to continue a conversation).');
      }
      const job = await startChatJob(auth, { message, scopeId: scope_id, agentId: agent_id, sessionId: session_id });
      await waitForJob(job, CHAT_BLOCK_MS);

      if (job.status === 'completed') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { session_id: job.sessionId, status: 'completed', reply: job.reply },
                null,
                2,
              ),
            },
          ],
        };
      }
      if (job.status === 'error') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ session_id: job.sessionId, status: 'error', error: job.error }, null, 2) },
          ],
          isError: true,
        };
      }
      // Still running past the soft deadline — hand back the session id to poll.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                session_id: job.sessionId,
                status: 'running',
                message: 'The agent is still working. Poll chat_result with this session_id.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ---- chat_result -------------------------------------------------------
  server.registerTool(
    'chat_result',
    {
      description:
        'Poll for the result of a long-running chat. Pass the session_id returned by chat when ' +
        'status was "running". Returns status running | completed | error, and the reply when done.',
      inputSchema: { session_id: z.string().uuid() },
    },
    async ({ session_id }) => {
      const job = chatJobs.get(session_id);
      if (!job) {
        // Not in the in-memory map (e.g. after a restart) — the run's reply is
        // persisted in chat history; direct the client to the history API.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  session_id,
                  status: 'unknown',
                  message:
                    'No active job for this session (it may have finished earlier or the server restarted). ' +
                    'The conversation and its reply are available via the chat history API.',
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const payload =
        job.status === 'completed'
          ? { session_id, status: 'completed', reply: job.reply }
          : job.status === 'error'
            ? { session_id, status: 'error', error: job.error }
            : { session_id, status: 'running' };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: job.status === 'error' };
    },
  );

  // ---- get_workspace -----------------------------------------------------
  server.registerTool(
    'get_workspace',
    {
      description:
        'List or read files the agent produced in a chat session workspace. Provide the ' +
        'session_id and its scope_id. Omit path to get the file tree; pass a relative path to ' +
        'read that file.',
      inputSchema: {
        session_id: z.string().uuid(),
        scope_id: z.string().uuid(),
        path: z.string().optional(),
      },
    },
    async ({ session_id, scope_id, path }) => {
      if (path) {
        const content = await workspaceManager.readWorkspaceFileFromS3(
          auth.organizationId,
          scope_id,
          session_id,
          path,
        );
        if (content === null) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ path, error: 'File not found or not readable as text' }, null, 2) }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: content }] };
      }
      const tree = await workspaceManager.listWorkspaceFilesFromS3(auth.organizationId, scope_id, session_id);
      return { content: [{ type: 'text', text: JSON.stringify(tree ?? [], null, 2) }] };
    },
  );

  return server;
}

// ============================================================================
// Route registration
// ============================================================================

export async function mcpServerRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/mcp — Streamable HTTP MCP endpoint (stateless).
   * Each request creates a fresh server+transport (no server-side session
   * state); conversation continuity is carried by the chat tool's session_id.
   */
  fastify.post('/v1/mcp', async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await resolveAuth(request); // throws AppError on failure

    const server = buildMcpServer(auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Clean up when the underlying HTTP response closes.
    reply.raw.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    // Hand the raw Node req/res to the MCP transport. Fastify has already parsed
    // the JSON body, so pass it through as parsedBody.
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);

    // The transport writes directly to reply.raw; tell Fastify we're done.
    reply.hijack();
  });

  // Some MCP clients probe GET/DELETE on the endpoint for server-initiated
  // streams / session teardown. Stateless mode doesn't support those; return
  // 405 with the MCP-shaped JSON-RPC error so clients fall back to POST.
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This MCP server is stateless; use POST /v1/mcp.' },
      id: null,
    });
  };
  fastify.get('/v1/mcp', methodNotAllowed);
  fastify.delete('/v1/mcp', methodNotAllowed);
}
