/**
 * Agent Access Middleware
 *
 * Fastify preHandler factory that enforces agent-level access control.
 * Use after the `authenticate` middleware.
 *
 * Usage:
 *   fastify.put('/:id', {
 *     preHandler: [authenticate, requireAgentAccess('admin')],
 *   }, handler)
 *
 * The middleware reads the agent ID from:
 *   1. request.params.id (for /agents/:id routes)
 *   2. request.params.agentId (for routes with explicit agentId param)
 *
 * Access level hierarchy (highest to lowest):
 *   owner  — full control (delete, transfer ownership)
 *   admin  — edit agent config, manage skills, manage permissions
 *   invoke — call agent in chat
 *   view   — see agent in lists and profiles
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { agentAccessService, type AgentAccessLevel } from '../services/agentAccess.service.js';

/**
 * Creates a Fastify preHandler that enforces agent-level access.
 *
 * @param minLevel - Minimum access level required
 */
export function requireAgentAccess(minLevel: AgentAccessLevel) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = request.user;
    if (!user) {
      return reply.status(401).send({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
        requestId: request.id,
      });
    }

    // Org owner/admin bypass agent-level checks
    if (user.role === 'owner' || user.role === 'admin') {
      return;
    }

    const params = request.params as Record<string, string>;
    const agentId = params?.id || params?.agentId;

    if (!agentId) {
      // No agent ID in request — skip agent check
      return;
    }

    const hasAccess = await agentAccessService.checkAccess(
      user.id,
      user.orgId,
      agentId,
      minLevel,
    );

    if (!hasAccess) {
      return reply.status(403).send({
        error: 'You do not have permission to perform this action on this agent.',
        code: 'AGENT_ACCESS_DENIED',
        requestId: request.id,
      });
    }
  };
}
