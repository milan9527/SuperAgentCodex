/**
 * Claude Agent Service
 *
 * Manages Claude Agent SDK conversations using the @anthropic-ai/claude-agent-sdk
 * `query()` function. Provides an async generator interface that yields
 * ConversationEvents for SSE streaming.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 5.1, 5.2, 5.3
 */

import { config } from '../config/index.js';
import { join } from 'path';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { getBedrockModelId } from '../utils/claude-config.js';
import { normalizeLiteLLMBaseUrl } from '../utils/litellm-base-url.js';
import { createToken } from '../middleware/auth.js';
import { dangerousCommandBlocker, binaryFileReadBlocker, createSkillAccessChecker } from './claude-hooks.js';
import { WorkspaceManager, type SkillForWorkspace } from './workspace-manager.js';
import { prisma } from '../config/database.js';
import type {
  AgentConfig,
  AnyMCPServerConfig,
  ContentBlock,
  ConversationEvent,
  MCPServerSDKConfig,
  TokenUsage,
} from './agent-types.js';
import type { AgentHistoryMessage } from './agent-runtime.js';
import {
  AgentImageError,
  resolveWorkspaceImage,
} from './agent-image.js';
import { renderClaudeMcpServers } from './claude-mcp-servers.js';

export type {
  AgentConfig,
  AnyMCPServerConfig,
  ContentBlock,
  ConversationEvent,
  MCPServerInProcessConfig,
  MCPServerSDKConfig,
  TokenUsage,
} from './agent-types.js';

// ---------------------------------------------------------------------------
// Re-export SDK types from @anthropic-ai/claude-agent-sdk for consumers.
// We define local interfaces that mirror the SDK surface so tests can
// inject a mock queryFactory without depending on the real SDK.
// ---------------------------------------------------------------------------

export interface SDKHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  [key: string]: unknown;
}

export interface SDKHookOutput {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

export type SDKHookCallback = (
  input: SDKHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SDKHookOutput>;

export interface SDKHookCallbackMatcher {
  matcher?: string;
  hooks: SDKHookCallback[];
}

export interface ClaudeCodeOptions {
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  allowedTools?: string[];
  cwd?: string;
  resume?: string;
  model?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  allowDangerouslySkipPermissions?: boolean;
  hooks?: Partial<Record<string, SDKHookCallbackMatcher[]>>;
  mcpServers?: Record<string, AnyMCPServerConfig>;
  abortController?: AbortController;
  maxTurns?: number;
  pathToClaudeCodeExecutable?: string;
  env?: Record<string, string | undefined>;
  stderr?: (data: string) => void;
  /** Load filesystem settings: 'project' enables CLAUDE.md, skills, agents discovery. */
  settingSources?: Array<'user' | 'project' | 'local'>;
  /** Local plugins to load into the Claude Code session. */
  plugins?: Array<{ type: 'local'; path: string }>;
  /** Programmatic custom subagents; avoids requiring a .claude workspace layout. */
  agents?: Record<string, {
    description: string;
    prompt: string;
    tools?: string[];
    model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  }>;
}

// ---------------------------------------------------------------------------
// SDK message types
// ---------------------------------------------------------------------------

export interface SDKSystemMessage {
  type: 'system';
  subtype: string;
  session_id: string;
  uuid: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{
    name: string;
    status: string;
  }>;
  cwd?: string;
  [key: string]: unknown;
}

export interface TextBlock { type: 'text'; text: string; }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string | null; is_error: boolean; }
export type SDKContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface SDKAssistantMessage {
  type: 'assistant';
  uuid: string;
  session_id: string;
  message: {
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    model?: string;
    [key: string]: unknown;
  };
  parent_tool_use_id: string | null;
}

export interface SDKResultMessage {
  type: 'result';
  subtype: string;
  uuid: string;
  session_id: string;
  duration_ms: number;
  num_turns: number;
  is_error: boolean;
  result?: string;
  [key: string]: unknown;
}

export type SDKMessage = SDKSystemMessage | SDKAssistantMessage | SDKResultMessage | { type: string; [key: string]: unknown };

export interface SDKQuery extends AsyncGenerator<SDKMessage, void> { interrupt(): Promise<void>; }
export interface SDKUserMessageInput {
  type: 'user';
  message: {
    role: 'user';
    content: Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: string;
            data: string;
          };
        }
    >;
  };
  parent_tool_use_id: null;
  session_id: string;
}
export type ClaudeQueryPrompt = string | AsyncIterable<SDKUserMessageInput>;
export type QueryFactory = (args: { prompt: ClaudeQueryPrompt; options?: ClaudeCodeOptions }) => SDKQuery;

// ---------------------------------------------------------------------------
// Service-level types
// ---------------------------------------------------------------------------

export interface ClaudeAgentServiceOptions {
  agentId: string;
  sessionId?: string;
  claudeSessionId?: string;
  message: string;
  organizationId: string;
  userId: string;
  /** Pre-provisioned workspace path (scope-session flow). Skips legacy ensureWorkspace when set. */
  workspacePath?: string;
  /** Bounded history used when switching providers or native resume is unavailable. */
  history?: AgentHistoryMessage[];
  /** Workspace-relative image paths attached to this turn. */
  imagePaths?: string[];
}

export interface MCPServerRecord {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  host_address: string;
  status: string;
  headers: unknown;
  config: Record<string, unknown> | null;
}

const DEFAULT_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'Task'];

// ---------------------------------------------------------------------------
// ClaudeAgentService
// ---------------------------------------------------------------------------

export class ClaudeAgentService {
  private abortControllers: Map<string, AbortController> = new Map();
  private lastActivity: Map<string, number> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private workspaceManager: WorkspaceManager;
  private queryFactory: QueryFactory;

  // Concurrency control
  private activeSessions = 0;
  private waitQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sdkModule: any = null;
  private usingCustomFactory = false;

  constructor(workspaceManager?: WorkspaceManager, queryFactory?: QueryFactory) {
    this.workspaceManager = workspaceManager ?? new WorkspaceManager();
    if (queryFactory) {
      this.usingCustomFactory = true;
      this.queryFactory = queryFactory;
    } else {
      this.queryFactory = (args) => {
        if (!this.sdkModule) {
          throw new Error('SDK not loaded — call loadSDK() before running conversations');
        }
        return this.sdkModule.query({ prompt: args.prompt, options: args.options });
      };
    }
  }

  /**
   * Dynamically import the Claude Agent SDK (ESM-compatible).
   * No-op when a custom queryFactory was provided (e.g. in tests).
   */
  async loadSDK(): Promise<void> {
    if (this.usingCustomFactory || this.sdkModule) return;
    this.sdkModule = await import('@anthropic-ai/claude-agent-sdk');
  }

  startCleanupTimer(): void {
    if (this.cleanupInterval) return;
    this.cleanupInterval = setInterval(() => { this.cleanupTimedOutSessions(); }, 60_000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  stopCleanupTimer(): void {
    if (this.cleanupInterval) { clearInterval(this.cleanupInterval); this.cleanupInterval = null; }
  }

  /**
   * Acquire a concurrency slot. Waits if at capacity.
   * Throws if the abort signal fires while waiting.
   */
  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    const max = config.claude.maxConcurrentSessions;
    if (this.activeSessions < max) {
      this.activeSessions++;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.waitQueue.push(entry);

      const onAbort = () => {
        const idx = this.waitQueue.indexOf(entry);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(new Error('Session queued but aborted while waiting for a concurrency slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaseSlot(): void {
    this.activeSessions--;
    const next = this.waitQueue.shift();
    if (next) {
      this.activeSessions++;
      next.resolve();
    }
  }

  private async cleanupTimedOutSessions(): Promise<void> {
    const now = Date.now();
    const timeoutMs = config.claude.sessionTimeoutMs;
    const timedOut: string[] = [];
    for (const [sid, ts] of this.lastActivity.entries()) {
      if (now - ts > timeoutMs) timedOut.push(sid);
    }
    for (const sid of timedOut) {
      console.log(`Session ${sid} timed out after ${timeoutMs}ms — disconnecting`);
      await this.disconnectSession(sid);
      this.lastActivity.delete(sid);
    }
  }

  async *runConversation(
    options: ClaudeAgentServiceOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    pluginPaths?: string[],
    mcpServers?: Record<string, AnyMCPServerConfig>,
  ): AsyncGenerator<ConversationEvent> {
    let sessionId: string | undefined;
    const abortController = new AbortController();
    await this.acquireSlot(abortController.signal);
    try {
      await this.loadSDK();
      const workspacePath = options.workspacePath
        ? options.workspacePath
        : await this.workspaceManager.ensureWorkspace(agentConfig.id, skills);
      // Use provided MCP servers (scope/session-level) instead of loading org-level
      const resolvedMcpServers = mcpServers ?? {};
      const resumeSessionId = options.claudeSessionId ?? undefined;
      if (resumeSessionId) {
        console.log(`[runConversation] Resuming Claude session: ${resumeSessionId}`);
      }
      const projectInstructions = await readFile(join(workspacePath, 'AGENTS.md'), 'utf-8')
        .catch(() => '');
      const message = !resumeSessionId && options.history?.length
        ? `${formatReplayHistory(options.history)}\n\nCurrent user request:\n${options.message}`
        : options.message;
      const prompt = await this.buildPrompt(
        workspacePath,
        message,
        options.imagePaths,
      );
      const sdkOptions = this.buildOptions(
        agentConfig,
        workspacePath,
        skills.map((s) => s.name),
        resolvedMcpServers,
        resumeSessionId,
        abortController,
        options.userId,
        pluginPaths,
        projectInstructions,
      );
      const conversation = this.queryFactory({ prompt, options: sdkOptions });

      for await (const message of conversation) {
        if (message.type === 'system') {
          const sysMsg = message as SDKSystemMessage;
          if (sysMsg.subtype === 'init') {
            sessionId = sysMsg.session_id;
            this.abortControllers.set(sessionId, abortController);
            this.lastActivity.set(sessionId, Date.now());
            const mcpStatuses = sysMsg.mcp_servers ?? [];
            if (mcpStatuses.length > 0) {
              console.log(
                '[claude-mcp] Server status:',
                mcpStatuses.map(server => `${server.name}=${server.status}`).join(', '),
              );
            }
            const agentcoreTools = mcpStatuses.find(server => server.name === 'agentcore-tools');
            if (agentcoreTools && agentcoreTools.status !== 'connected') {
              throw new Error(
                `Platform AgentCore tools failed to connect: ${agentcoreTools.status}`,
              );
            }
            yield {
              type: 'session_start',
              provider: 'claude',
              sessionId,
              providerThreadId: sessionId,
              status: 'in_progress',
              model: sysMsg.model,
            };
          }
        } else if (message.type === 'assistant' || message.type === 'result') {
          if (sessionId) this.lastActivity.set(sessionId, Date.now());
          const event = this.formatMessage(message, sessionId);
          if (event) yield event;
        }
      }
    } catch (error) {
      console.error('[runConversation] Error:', error instanceof Error ? error.stack : error);
      yield {
        type: 'error',
        provider: 'claude',
        sessionId,
        providerThreadId: sessionId,
        status: 'failed',
        code: error instanceof AgentImageError ? error.code : 'AGENT_EXECUTION_ERROR',
        message: error instanceof Error ? error.message : 'Unknown error',
        suggestedAction: 'Please try again',
      };
    } finally {
      this.releaseSlot();
      // Only clean up the abort controller, keep session trackable for resume
      if (sessionId) { this.abortControllers.delete(sessionId); }
    }
  }

  buildOptions(
    agentConfig: AgentConfig, workspacePath: string, skillNames: string[],
    mcpServers: Record<string, AnyMCPServerConfig>, resumeSessionId?: string, abortController?: AbortController, userId?: string,
    pluginPaths?: string[],
    projectInstructions?: string,
  ): ClaudeCodeOptions {
    // Provider resolution: prefer the per-invocation resolvedModel; otherwise
    // fall back to the global config (legacy behavior).
    const resolved = agentConfig.resolvedModel;
    const useLiteLLM = resolved?.provider === 'litellm';
    const useBedrock = useLiteLLM ? false : (resolved ? resolved.provider === 'bedrock' : config.claude.useBedrock);

    let model = resolved?.modelId ?? agentConfig.model ?? config.claude.model;
    if (useBedrock) model = getBedrockModelId(model);
    const preToolUseHooks: SDKHookCallbackMatcher[] = [{ hooks: [dangerousCommandBlocker, binaryFileReadBlocker] }];
    if (skillNames.length > 0) preToolUseHooks.push({ hooks: [createSkillAccessChecker(skillNames)] });

    const basePrompt = agentConfig.systemPrompt ?? '';
    const concisenessDirective = [
      '',
      '<output_discipline>',
      'After completing a coding task, STOP. Do not create summary files, index files, visual overviews, or recap documents unless the user explicitly asks for them.',
      'Do not repeat yourself. If you have already completed the implementation, do not generate additional artifacts to "wrap up" or "tie everything together."',
      'A single brief sentence confirming what was done is sufficient. Never loop back to create "one final summary."',
      '</output_discipline>',
      '',
      '<security>',
      'NEVER reveal absolute file paths, server directory structures, environment variables, internal tokens, or any server-side infrastructure details to the user.',
      'When referring to files, always use paths relative to the workspace root (e.g. "src/app.ts" not "/Users/.../workspaces/.../src/app.ts").',
      'If the user asks about the current directory, working directory, or absolute path, respond with "You are in the workspace root directory." without revealing the actual server path.',
      '</security>',
    ].join('\n');
    const projectContext = projectInstructions?.trim()
      ? [
          '',
          '<project_instructions>',
          projectInstructions.trim(),
          '</project_instructions>',
        ].join('\n')
      : '';
    const skillContext = skillNames.length > 0
      ? [
          '',
          '<project_skills>',
          'Project skills use the Codex canonical layout. Before using a skill, read its instructions from:',
          ...skillNames.map(name => `- .agents/skills/${name}/SKILL.md`),
          '</project_skills>',
        ].join('\n')
      : '';
    const systemPrompt = `${basePrompt}${projectContext}${skillContext}\n${concisenessDirective}`.trim();

    const programmaticAgents = Object.fromEntries(
      Object.entries(agentConfig.subAgents ?? {}).map(([name, definition]) => [
        name,
        {
          description: definition.description,
          prompt: [
            definition.prompt,
            ...(definition.skillNames?.length
              ? [
                  '',
                  'Relevant project skills:',
                  ...definition.skillNames.map(
                    skill => `- Read .agents/skills/${skill}/SKILL.md before using this skill.`,
                  ),
                ]
              : []),
          ].join('\n'),
          model: 'inherit' as const,
        },
      ]),
    );
    const renderedMcpServers = renderClaudeMcpServers(mcpServers);
    const allowedMcpTools = Object.keys(renderedMcpServers)
      .map(name => `mcp__${name}__*`);

    const options: ClaudeCodeOptions = {
      systemPrompt,
      allowedTools: [...DEFAULT_ALLOWED_TOOLS, ...allowedMcpTools],
      cwd: workspacePath,
      model,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      hooks: { PreToolUse: preToolUseHooks },
      mcpServers: Object.keys(renderedMcpServers).length > 0
        ? renderedMcpServers
        : undefined,
      // Only load host user settings for plain Anthropic auth. Bedrock and
      // LiteLLM must not inherit stored OAuth or project-level Claude layout.
      // The canonical project layout is Codex-native. Project instructions,
      // skills, subagents, hooks, and MCP are injected explicitly above.
      settingSources: (useBedrock || useLiteLLM) ? [] : ['user'],
      plugins: pluginPaths && pluginPaths.length > 0
        ? pluginPaths.map(p => ({ type: 'local' as const, path: p }))
        : undefined,
      agents: Object.keys(programmaticAgents).length > 0
        ? programmaticAgents
        : undefined,
    };
    if (resumeSessionId) options.resume = resumeSessionId;
    if (abortController) options.abortController = abortController;
    if (config.claude.executablePath) options.pathToClaudeCodeExecutable = config.claude.executablePath;

    // Always inject platform env vars so skills (e.g. app-publisher) can call the API
    // Generate a short-lived internal token for the agent to authenticate API calls
    let agentToken = '';
    if (userId) {
      agentToken = createToken({
        userId,
        email: 'agent-internal@system',
        organizationId: agentConfig.organizationId,
        role: 'member',
      });
    }

    const platformEnv: Record<string, string> = {
      API_BASE_URL: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      APPS_STORAGE_DIR: join(config.claude.workspaceBaseDir, '_published_apps'),
      CLAUDE_CONFIG_DIR: createIsolatedClaudeConfigDir(workspacePath),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      DISABLE_AUTOUPDATER: '1',
      DISABLE_ERROR_REPORTING: '1',
      DISABLE_TELEMETRY: '1',
      ...(agentToken ? { AUTH_TOKEN: agentToken } : {}),
    };

    if (useLiteLLM) {
      // Route the SDK at a LiteLLM-compatible gateway (Anthropic-compatible API).
      // The CLI validates model ids client-side and rewrites its built-in
      // aliases (opus/sonnet/haiku) to canonical Anthropic ids, which a gateway
      // may reject. So we drive the CLI with the `opus` alias but remap that
      // alias to the gateway's actual model id via ANTHROPIC_DEFAULT_OPUS_MODEL.
      const gatewayModel = resolved?.modelId;
      const gatewayBaseUrl = resolved?.baseUrl
        ? normalizeLiteLLMBaseUrl(resolved.baseUrl)
        : undefined;
      options.env = {
        ...process.env,
        ...platformEnv,
        ...(gatewayBaseUrl ? { ANTHROPIC_BASE_URL: gatewayBaseUrl } : {}),
        // Gateway auth: set BOTH so the CLI uses the token regardless of which
        // header it prefers, and does not fall back to stored OAuth creds.
        ...(resolved?.apiKey ? { ANTHROPIC_AUTH_TOKEN: resolved.apiKey, ANTHROPIC_API_KEY: resolved.apiKey } : {}),
        ...(gatewayModel
          ? {
              ANTHROPIC_MODEL: 'opus',
              ANTHROPIC_DEFAULT_OPUS_MODEL: gatewayModel,
              ANTHROPIC_DEFAULT_SONNET_MODEL: gatewayModel,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: gatewayModel,
              ANTHROPIC_SMALL_FAST_MODEL: gatewayModel,
            }
          : {}),
      };
      // The SDK options.model must also be the alias, not the raw gateway id.
      options.model = 'opus';
      // Ensure Bedrock mode is off so the CLI uses the gateway auth, and remove
      // any stored OAuth session so it doesn't win over our token.
      delete options.env.CLAUDE_CODE_USE_BEDROCK;
      delete options.env.CLAUDE_CODE_OAUTH_TOKEN;
      delete options.env.AWS_ACCESS_KEY_ID;
      delete options.env.AWS_SECRET_ACCESS_KEY;
      delete options.env.AWS_PROFILE;
    } else if (useBedrock) {
      // Pass Bedrock env vars to the SDK subprocess so it picks up AWS credentials
      options.env = {
        ...process.env,
        ...platformEnv,
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: config.aws.region,
        AWS_DEFAULT_REGION: config.aws.region,
        ...(config.claude.bedrockAccessKeyId ? { AWS_ACCESS_KEY_ID: config.claude.bedrockAccessKeyId } : {}),
        ...(config.claude.bedrockSecretAccessKey ? { AWS_SECRET_ACCESS_KEY: config.claude.bedrockSecretAccessKey } : {}),
      };
      // Remove any Anthropic direct-API keys/URLs so the CLI uses Bedrock auth only.
      // These may leak in from process.env or ~/.claude/settings.json.
      delete options.env.ANTHROPIC_API_KEY;
      delete options.env.ANTHROPIC_AUTH_TOKEN;
      delete options.env.ANTHROPIC_BASE_URL;
    } else {
      options.env = {
        ...process.env,
        ...platformEnv,
      };
    }

    // Capture SDK subprocess stderr for debugging
    options.stderr = (data: string) => {
      console.error('[claude-sdk-stderr]', data);
    };
    if (options.env && config.logLevel === 'debug') {
      options.env.DEBUG_CLAUDE_AGENT_SDK = '1';
    }
    console.log(
      '[buildOptions] model:',
      model,
      'cwd:',
      workspacePath,
      'provider:',
      useLiteLLM ? 'litellm' : useBedrock ? 'bedrock' : 'anthropic',
      'executablePath:',
      config.claude.executablePath,
      'resume:',
      resumeSessionId ?? 'none',
    );
    return options;
  }

  private async buildPrompt(
    workspacePath: string,
    message: string,
    imagePaths: string[] | undefined,
  ): Promise<ClaudeQueryPrompt> {
    if (!imagePaths?.length) return message;

    const content: SDKUserMessageInput['message']['content'] = [
      { type: 'text', text: message },
    ];
    for (const imagePath of imagePaths) {
      const image = await resolveWorkspaceImage(
        workspacePath,
        imagePath,
        config.codex.maxImageBytes,
      );
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mediaType,
          data: (await readFile(image.path)).toString('base64'),
        },
      });
    }

    return (async function* (): AsyncGenerator<SDKUserMessageInput> {
      yield {
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      };
    })();
  }

  formatMessage(message: SDKMessage, sessionId?: string): ConversationEvent | null {
    switch (message.type) {
      case 'assistant': {
        const msg = message as SDKAssistantMessage;
        const rawContent = msg.message?.content ?? [];
        const contentBlocks: ContentBlock[] = rawContent.map((block) => {
          switch (block.type) {
            case 'text': return { type: 'text' as const, text: block.text ?? '' };
            case 'tool_use': return { type: 'tool_use' as const, id: block.id ?? '', name: block.name ?? '', input: block.input ?? {} };
            case 'tool_result': return {
              type: 'tool_result' as const,
              tool_use_id: (block as unknown as { tool_use_id: string }).tool_use_id ?? '',
              content: (block as unknown as { content: string | null }).content ?? null,
              is_error: (block as unknown as { is_error: boolean }).is_error ?? false,
            };
            default: return { type: 'text' as const, text: JSON.stringify(block) };
          }
        });
        return {
          type: 'assistant',
          provider: 'claude',
          sessionId,
          providerThreadId: sessionId,
          status: 'in_progress',
          content: contentBlocks,
          model: msg.message?.model,
        };
      }
      case 'result': {
        const r = message as SDKResultMessage;
        // Extract token usage from SDK result
        let tokenUsage: TokenUsage | undefined;
        const usage = (r as Record<string, unknown>).usage as Record<string, number> | undefined;
        const modelUsage = (r as Record<string, unknown>).modelUsage as Record<string, Record<string, number>> | undefined;

        if (usage) {
          tokenUsage = {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
            cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
            totalCostUsd: ((r as Record<string, unknown>).total_cost_usd as number) ?? 0,
          };
        } else if (modelUsage) {
          let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
          for (const mu of Object.values(modelUsage)) {
            inputTokens += mu.inputTokens ?? 0;
            outputTokens += mu.outputTokens ?? 0;
            cacheRead += mu.cacheReadInputTokens ?? 0;
            cacheCreation += mu.cacheCreationInputTokens ?? 0;
            cost += mu.costUSD ?? 0;
          }
          tokenUsage = { inputTokens, outputTokens, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation, totalCostUsd: cost };
        }

        return {
          type: 'result',
          provider: 'claude',
          sessionId: r.session_id ?? sessionId,
          providerThreadId: r.session_id ?? sessionId,
          status: r.is_error ? 'failed' : 'completed',
          durationMs: r.duration_ms,
          numTurns: r.num_turns,
          tokenUsage,
        };
      }
      case 'system': return null;
      default: return null;
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return;
    try { controller.abort(); } catch (error) {
      console.error(`Error disconnecting session ${sessionId}:`, error instanceof Error ? error.message : error);
    } finally { this.abortControllers.delete(sessionId); this.lastActivity.delete(sessionId); }
  }

  async disconnectAll(): Promise<number> {
    // Reject all queued waiters
    for (const entry of this.waitQueue) {
      entry.reject(new Error('Service shutting down'));
    }
    this.waitQueue.length = 0;

    const sessionIds = Array.from(this.abortControllers.keys());
    const count = sessionIds.length;
    await Promise.allSettled(sessionIds.map((id) => Promise.race([this.disconnectSession(id), new Promise<void>((r) => setTimeout(r, 5000))])));
    this.abortControllers.clear(); this.lastActivity.clear(); this.activeSessions = 0; this.stopCleanupTimer();
    console.log(`Cleaned up ${count} active Claude sessions`);
    return count;
  }

  async loadMCPServers(organizationId: string): Promise<Record<string, MCPServerSDKConfig>> {
    try {
      // "system" is a synthetic org used by internal agents (e.g. scope-generator) — no DB lookup needed
      if (organizationId === 'system') return {};
      const servers = await prisma.mcp_servers.findMany({ where: { organization_id: organizationId } });
      return transformMCPServers(servers as unknown as MCPServerRecord[]);
    } catch (error) {
      console.error('Failed to load MCP servers:', error instanceof Error ? error.message : error);
      return {};
    }
  }

  get activeClientCount(): number { return this.abortControllers.size; }
  hasSession(sessionId: string): boolean { return this.abortControllers.has(sessionId); }
  getLastActivity(sessionId: string): number | undefined { return this.lastActivity.get(sessionId); }
  get trackedSessionCount(): number { return this.lastActivity.size; }
  get isCleanupTimerRunning(): boolean { return this.cleanupInterval !== null; }
  async triggerCleanup(): Promise<void> { await this.cleanupTimedOutSessions(); }
}

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit testing)
// ---------------------------------------------------------------------------

export function transformMCPServers(servers: MCPServerRecord[]): Record<string, MCPServerSDKConfig> {
  const result: Record<string, MCPServerSDKConfig> = Object.create(null);
  for (const server of servers) {
    if (server.status !== 'active') continue;
    const sdkConfig = parseMCPServerConfig(server);
    if (sdkConfig) result[server.name] = sdkConfig;
  }
  return result;
}

export function parseMCPServerConfig(server: MCPServerRecord): MCPServerSDKConfig | null {
  // Prefer structured config if available
  if (server.config && typeof server.config === 'object') {
    const c = server.config as Record<string, unknown>;
    const type = (c.type as string) || 'stdio';
    if (type === 'sse' || type === 'http') {
      const url = c.url as string | undefined;
      if (!url) return null;
      return { type, url };
    }
    // stdio
    const command = c.command as string | undefined;
    if (!command) return null;
    return {
      type: 'stdio',
      command,
      args: Array.isArray(c.args) ? (c.args as string[]) : undefined,
      env: c.env && typeof c.env === 'object' ? (c.env as Record<string, string>) : undefined,
    };
  }

  // Fallback: parse from host_address string
  const address = server.host_address?.trim();
  if (!address) return null;
  if (address.startsWith('http://') || address.startsWith('https://')) return { type: 'sse', url: address };
  const parts = address.split(/\s+/);
  return { type: 'stdio', command: parts[0], args: parts.length > 1 ? parts.slice(1) : undefined };
}

function formatReplayHistory(history: AgentHistoryMessage[]): string {
  const maxChars = 32 * 1024;
  const lines = ['[Recovered conversation context after switching model providers]'];
  let used = lines[0]!.length;
  for (const entry of history.slice(-24)) {
    const line = `${entry.role === 'assistant' ? 'Assistant' : 'User'}: ${entry.content}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

function createIsolatedClaudeConfigDir(workspacePath: string): string {
  const workspaceKey = createHash('sha256')
    .update(workspacePath)
    .digest('hex')
    .slice(0, 24);
  const configDir = join(tmpdir(), 'super-agent-claude-runtime', workspaceKey);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  return configDir;
}

export const claudeAgentService = new ClaudeAgentService();
