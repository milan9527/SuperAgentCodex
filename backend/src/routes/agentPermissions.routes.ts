/**
 * Agent Permissions Routes
 *
 * API endpoints for managing agent-level access control.
 * Allows agent owners (and org admins) to manage who can access each agent.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { requireAgentAccess } from '../middleware/agentAccess.js';
import { agentAccessService, type AgentAccessLevel } from '../services/agentAccess.service.js';
import { prisma } from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

interface AgentParams { id: string }
interface PermissionParams { id: string; permId: string }
interface GrantBody { user_id: string; permission?: AgentAccessLevel }
interface UpdatePermBody { permission: AgentAccessLevel }
interface VisibilityBody { visibility: 'public' | 'scope_default' | 'private' }

export async function agentPermissionRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /api/agents/:id/permissions
   * List all explicit permissions for an agent.
   * Requires at least admin access to the agent.
   */
  fastify.get<{ Params: AgentParams }>(
    '/:id/permissions',
    { preHandler: [authenticate, requireAgentAccess('admin')] },
    async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
      const { id: agentId } = request.params;

      const permissions = await agentAccessService.listPermissions(agentId);

      // Enrich with user info
      const userIds = permissions.map((p: any) => p.user_id);
      const profiles = userIds.length > 0
        ? await prisma.profiles.findMany({
            where: { id: { in: userIds } },
            select: { id: true, full_name: true, username: true, avatar_url: true },
          })
        : [];
      const profileMap = new Map(profiles.map((p: any) => [p.id, p]));

      const enriched = permissions.map((p: any) => {
        const profile = profileMap.get(p.user_id);
        return {
          id: p.id,
          user_id: p.user_id,
          permission: p.permission,
          granted_by: p.granted_by,
          name: profile?.full_name || profile?.username || null,
          email: profile?.username || null,
          avatar_url: profile?.avatar_url || null,
          created_at: p.created_at,
        };
      });

      return reply.status(200).send({ data: enriched });
    },
  );

  /**
   * GET /api/agents/:id/access-level
   * Get the current user's effective access level for an agent.
   * Any authenticated user can check their own access level.
   */
  fastify.get<{ Params: AgentParams }>(
    '/:id/access-level',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<{ Params: AgentParams }>, reply: FastifyReply) => {
      const { id: agentId } = request.params;
      const user = request.user!;

      const level = await agentAccessService.getEffectiveLevel(
        user.id, user.role, user.orgId, agentId,
      );

      return reply.status(200).send({ agent_id: agentId, level });
    },
  );

  /**
   * POST /api/agents/:id/permissions
   * Grant a permission to a user for an agent.
   * Requires admin access to the agent.
   */
  fastify.post<{ Params: AgentParams; Body: GrantBody }>(
    '/:id/permissions',
    {
      preHandler: [authenticate, requireAgentAccess('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['user_id'],
          properties: {
            user_id: { type: 'string', format: 'uuid' },
            permission: {
              type: 'string',
              enum: ['admin', 'invoke', 'view'],
              default: 'invoke',
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: AgentParams; Body: GrantBody }>, reply: FastifyReply) => {
      const { id: agentId } = request.params;
      const { user_id, permission } = request.body;
      const orgId = request.user!.orgId;

      // Verify user is in the same org
      const membership = await prisma.memberships.findFirst({
        where: { organization_id: orgId, user_id },
      });
      if (!membership) {
        throw AppError.notFound('User is not a member of this organization.');
      }

      // Cannot grant 'owner' via this endpoint — owner is set at creation
      const perm = permission ?? 'invoke';
      if (perm === 'owner') {
        throw AppError.validation('Cannot grant owner permission. Owner is the agent creator.');
      }

      const result = await agentAccessService.grantPermission(
        orgId, agentId, user_id, perm, request.user!.id,
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * PATCH /api/agents/:id/permissions/:permId
   * Update a permission level.
   * Requires admin access to the agent.
   */
  fastify.patch<{ Params: PermissionParams; Body: UpdatePermBody }>(
    '/:id/permissions/:permId',
    {
      preHandler: [authenticate, requireAgentAccess('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['permission'],
          properties: {
            permission: { type: 'string', enum: ['admin', 'invoke', 'view'] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: PermissionParams; Body: UpdatePermBody }>, reply: FastifyReply) => {
      const { permId } = request.params;
      const { permission } = request.body;

      const existing = await (prisma as any).agent_permissions.findUnique({ where: { id: permId } });
      if (!existing) {
        throw AppError.notFound('Permission record not found.');
      }

      // Cannot change owner permission
      if (existing.permission === 'owner') {
        throw AppError.validation('Cannot modify owner permission.');
      }

      const updated = await (prisma as any).agent_permissions.update({
        where: { id: permId },
        data: { permission },
      });

      return reply.status(200).send(updated);
    },
  );

  /**
   * DELETE /api/agents/:id/permissions/:permId
   * Revoke a permission.
   * Requires admin access to the agent.
   */
  fastify.delete<{ Params: PermissionParams }>(
    '/:id/permissions/:permId',
    { preHandler: [authenticate, requireAgentAccess('admin')] },
    async (request: FastifyRequest<{ Params: PermissionParams }>, reply: FastifyReply) => {
      const { permId } = request.params;

      const existing = await (prisma as any).agent_permissions.findUnique({ where: { id: permId } });
      if (!existing) {
        throw AppError.notFound('Permission record not found.');
      }

      // Cannot revoke owner permission
      if (existing.permission === 'owner') {
        throw AppError.validation('Cannot revoke owner permission. Transfer ownership instead.');
      }

      await agentAccessService.revokePermission(permId);
      return reply.status(204).send();
    },
  );

  /**
   * PATCH /api/agents/:id/visibility
   * Update agent visibility setting.
   * Requires admin access to the agent.
   */
  fastify.patch<{ Params: AgentParams; Body: VisibilityBody }>(
    '/:id/visibility',
    {
      preHandler: [authenticate, requireAgentAccess('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['visibility'],
          properties: {
            visibility: { type: 'string', enum: ['public', 'scope_default', 'private'] },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: AgentParams; Body: VisibilityBody }>, reply: FastifyReply) => {
      const { id: agentId } = request.params;
      const { visibility } = request.body;
      const orgId = request.user!.orgId;

      const updated = await agentAccessService.updateVisibility(agentId, orgId, visibility);
      return reply.status(200).send({ id: agentId, visibility: (updated as any).visibility ?? visibility });
    },
  );

  /**
   * GET /api/agents/user-access/:userId
   * Get all agents a specific user can access, with access source info.
   * Requires org admin access.
   */
  fastify.get<{ Params: { id: string; userId: string } }>(
    '/user-access/:userId',
    {
      preHandler: [authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string; userId: string } }>, reply: FastifyReply) => {
      const user = request.user!;
      // Only org admins/owners can view other users' access
      if (user.role !== 'owner' && user.role !== 'admin') {
        return reply.status(403).send({ error: 'Admin access required' });
      }

      const targetUserId = request.params.userId;
      const orgId = user.orgId;

      const result = await agentAccessService.getUserAccessibleAgents(targetUserId, orgId);
      return reply.status(200).send({ data: result });
    },
  );
}
