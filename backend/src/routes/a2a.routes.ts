/**
 * A2A Protocol Routes
 *
 * Exposes agents via the A2A (Agent-to-Agent) protocol, allowing external
 * systems to discover and invoke agents registered in AgentCore Registry.
 *
 * Endpoints:
 *   GET  /api/a2a/agents/:agentId/card   — Agent Card discovery
 *   POST /api/a2a/agents/:agentId/tasks/send — Send task to agent
 *   GET  /api/a2a/agents/:agentId/tasks/:taskId — Query task status
 *
 * Authentication: Bearer token (API key from api_keys table)
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { prisma } from '../config/database.js';
import { agentCoreRegistryService } from '../services/agentcore-registry.service.js';
import { AppError } from '../middleware/errorHandler.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentIdParams {
  Params: { agentId: string };
}

interface SendTaskBody {
  Params: { agentId: string };
  Body: {
    message: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  };
}

interface TaskIdParams {
  Params: { agentId: string; taskId: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validate bearer token from Authorization header against api_keys table.
 * Returns the organization_id if valid, throws otherwise.
 */
async function validateApiKey(request: FastifyRequest): Promise<string> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const apiKey = await prisma.api_keys.findFirst({
    where: { key_hash: token, is_active: true },
  }).catch(() => null);

  if (!apiKey) {
    throw AppError.unauthorized('Invalid API key');
  }

  return apiKey.organization_id;
}

/**
 * Load an A2A-enabled agent, verifying it belongs to the given org.
 */
async function loadA2AAgent(agentId: string, organizationId: string) {
  const agent = await prisma.agents.findFirst({
    where: { id: agentId, organization_id: organizationId, a2a_enabled: true },
  }).catch(() => null);

  if (!agent) {
    throw AppError.notFound('Agent not found or A2A not enabled');
  }

  return agent;
}

// ── Routes ────────────────────────────────────────────────────────────────────

export async function a2aRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/a2a/agents/:agentId/card
   *
   * Returns the A2A Agent Card for external discovery.
   * This is the standard A2A protocol discovery endpoint.
   */
  fastify.get<AgentIdParams>(
    '/agents/:agentId/card',
    async (request, reply) => {
      const { agentId } = request.params;
      const organizationId = await validateApiKey(request);
      const agent = await loadA2AAgent(agentId, organizationId);

      // Build Agent Card from local data
      const skills = await prisma.skills.findMany({
        where: {
          id: { in: agent.a2a_exposed_skills ?? [] },
          organization_id: organizationId,
        },
        select: { id: true, name: true, description: true },
      }).catch(() => [] as Array<{ id: string; name: string; description: string | null }>);

      const card = agentCoreRegistryService.buildA2ADescriptors({
        id: agent.id,
        name: agent.name,
        display_name: agent.display_name,
        role: agent.role ?? undefined,
        organization_id: agent.organization_id,
        business_scope_id: agent.business_scope_id ?? undefined,
        a2a_capabilities: agent.a2a_capabilities ?? undefined,
        skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? undefined })),
      });

      reply.send(card.agentCard);
    },
  );

  /**
   * POST /api/a2a/agents/:agentId/tasks/send
   *
   * Send a task to an A2A-enabled agent.
   * Creates a chat session and invokes the agent.
   */
  fastify.post<SendTaskBody>(
    '/agents/:agentId/tasks/send',
    async (request, reply) => {
      const { agentId } = request.params;
      const { message, sessionId, metadata } = request.body ?? {};
      const organizationId = await validateApiKey(request);

      if (!message || typeof message !== 'string') {
        throw AppError.validation('message is required');
      }

      const agent = await loadA2AAgent(agentId, organizationId);

      // Create a task record (using chat_sessions as the backing store)
      const taskId = sessionId || crypto.randomUUID();

      // Find or create session
      let session = sessionId
        ? await prisma.chat_sessions.findFirst({ where: { id: sessionId, organization_id: organizationId } })
        : null;

      if (!session) {
        session = await prisma.chat_sessions.create({
          data: {
            id: taskId,
            organization_id: organizationId,
            user_id: 'a2a-external',
            business_scope_id: agent.business_scope_id,
            agent_id: agentId,
            title: `A2A Task: ${message.substring(0, 100)}`,
            room_mode: 'single',
          },
        });
      }

      // Store the user message
      await prisma.chat_messages.create({
        data: {
          organization_id: organizationId,
          session_id: session.id,
          type: 'user',
          content: message,
          metadata: (metadata ?? {}) as any,
        },
      });

      // TODO: Invoke the agent asynchronously and stream response
      // For now, return the task ID for polling
      reply.status(202).send({
        taskId: session.id,
        status: 'submitted',
        agentId,
        agentName: agent.display_name,
        message: 'Task submitted. Poll GET /tasks/:taskId for status.',
      });
    },
  );

  /**
   * GET /api/a2a/agents/:agentId/tasks/:taskId
   *
   * Query the status of a previously submitted task.
   */
  fastify.get<TaskIdParams>(
    '/agents/:agentId/tasks/:taskId',
    async (request, reply) => {
      const { agentId, taskId } = request.params;
      const organizationId = await validateApiKey(request);

      // Verify agent exists and is A2A-enabled
      await loadA2AAgent(agentId, organizationId);

      // Load session and messages
      const session = await prisma.chat_sessions.findFirst({
        where: { id: taskId, organization_id: organizationId, agent_id: agentId },
      });

      if (!session) {
        throw AppError.notFound('Task not found');
      }

      const messages = await prisma.chat_messages.findMany({
        where: { session_id: taskId, organization_id: organizationId },
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          type: true,
          content: true,
          agent_id: true,
          created_at: true,
        },
      });

      const lastAiMessage = messages.filter(m => m.type === 'ai').pop();
      const status = lastAiMessage ? 'completed' : 'processing';

      reply.send({
        taskId,
        agentId,
        status,
        result: lastAiMessage?.content ?? null,
        messages: messages.map(m => ({
          role: m.type === 'user' ? 'user' : 'assistant',
          content: m.content,
          timestamp: m.created_at,
        })),
      });
    },
  );
}
