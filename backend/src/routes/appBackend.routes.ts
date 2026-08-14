/**
 * App Backend Routes
 *
 * REST API for managing InsForge backend instances attached to published apps.
 * Handles provisioning, lifecycle management, health checks, and usage metrics.
 */

import { FastifyInstance } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import { insforgeOrchestrator, type InstanceType } from '../services/insforge-orchestrator.js';
import { prisma } from '../config/database.js';

export async function appBackendRoutes(fastify: FastifyInstance): Promise<void> {

  // ── Provision a new InsForge backend for an app ─────────────────────────
  fastify.post<{
    Params: { appId: string };
    Body: { instance_type?: InstanceType; project_name?: string };
  }>(
    '/:appId/backend',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;
      const { instance_type = 'nano', project_name } = request.body ?? {};

      // Verify app belongs to org
      const app = await prisma.published_apps.findFirst({
        where: { id: appId, org_id: orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      // Generate project name if not provided
      const name = project_name || `app-${appId.slice(0, 8)}-${Date.now().toString(36)}`;

      try {
        const info = await insforgeOrchestrator.provisionProject({
          appId,
          orgId,
          projectName: name,
          instanceType: instance_type,
        });

        return reply.status(201).send({
          id: info.id,
          app_id: info.appId,
          project_name: info.projectName,
          status: info.status,
          access_host: info.accessHost,
          api_key: info.apiKey,
          mcp_endpoint: info.mcpEndpoint,
          ports: info.ports,
        });
      } catch (err: any) {
        if (err.message?.includes('already has a backend')) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // ── Get backend info for an app ─────────────────────────────────────────
  fastify.get<{ Params: { appId: string } }>(
    '/:appId/backend',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;

      // Verify app belongs to org
      const app = await prisma.published_apps.findFirst({
        where: { id: appId, org_id: orgId },
      });
      if (!app) return reply.status(404).send({ error: 'App not found' });

      const info = await insforgeOrchestrator.getByAppId(appId);
      if (!info) return reply.status(404).send({ error: 'No backend instance' });

      return reply.send(info);
    },
  );

  // ── Pause backend ───────────────────────────────────────────────────────
  fastify.post<{ Params: { appId: string } }>(
    '/:appId/backend/pause',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;

      const instance = await prisma.app_backend_instances.findFirst({
        where: { app_id: appId, org_id: orgId },
      });
      if (!instance) return reply.status(404).send({ error: 'No backend instance' });

      await insforgeOrchestrator.pauseProject(instance.id);
      return reply.send({ status: 'paused' });
    },
  );

  // ── Restore backend ─────────────────────────────────────────────────────
  fastify.post<{ Params: { appId: string } }>(
    '/:appId/backend/restore',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;

      const instance = await prisma.app_backend_instances.findFirst({
        where: { app_id: appId, org_id: orgId },
      });
      if (!instance) return reply.status(404).send({ error: 'No backend instance' });

      const info = await insforgeOrchestrator.restoreProject(instance.id);
      return reply.send(info);
    },
  );

  // ── Destroy backend ─────────────────────────────────────────────────────
  fastify.delete<{ Params: { appId: string } }>(
    '/:appId/backend',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;

      const instance = await prisma.app_backend_instances.findFirst({
        where: { app_id: appId, org_id: orgId },
      });
      if (!instance) return reply.status(404).send({ error: 'No backend instance' });

      await insforgeOrchestrator.destroyProject(instance.id);
      return reply.status(204).send();
    },
  );

  // ── Health check ────────────────────────────────────────────────────────
  fastify.get<{ Params: { appId: string } }>(
    '/:appId/backend/health',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;
      const orgId = request.user!.orgId;

      const instance = await prisma.app_backend_instances.findFirst({
        where: { app_id: appId, org_id: orgId },
      });
      if (!instance) return reply.status(404).send({ error: 'No backend instance' });

      const health = await insforgeOrchestrator.healthCheck(instance.id);
      return reply.send(health);
    },
  );

  // ── List all backend instances for the org ──────────────────────────────
  fastify.get(
    '/backends',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const instances = await insforgeOrchestrator.listByOrg(orgId);
      return reply.send({ data: instances });
    },
  );

  // ── Proxy: ensure backend is active (auto-restore if paused) ────────────
  fastify.post<{ Params: { appId: string } }>(
    '/:appId/backend/ensure-active',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { appId } = request.params;

      const info = await insforgeOrchestrator.ensureActive(appId);
      if (!info) return reply.status(404).send({ error: 'No backend instance or cannot restore' });

      return reply.send(info);
    },
  );

  // ── Resolve MCP configs for agent access ────────────────────────────────
  fastify.get<{ Querystring: { scope_id?: string } }>(
    '/backends/mcp-configs',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const scopeId = request.query.scope_id;

      const { agentAppDataResolver } = await import('../services/agent-app-data-resolver.js');
      const configs = await agentAppDataResolver.getAppBackendConfigs(orgId, {
        scopeId: scopeId || undefined,
      });

      return reply.send({
        data: configs.map(c => ({
          key: c.key,
          display_name: c.displayName,
          app_id: c.appId,
          app_name: c.appName,
        })),
        total: configs.length,
      });
    },
  );
}
