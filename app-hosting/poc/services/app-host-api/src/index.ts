import Fastify from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import * as db from './db';
import * as insforge from './insforge';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const ORCHESTRATOR = process.env.ORCHESTRATOR ?? 'docker'; // 'docker' (InsForge) or 'k8s'

const server = Fastify({ logger: true });

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Initialize metadata DB
  await db.initDB(process.env.DATABASE_URL);
  server.log.info('Metadata database initialized');
  server.log.info(`Orchestrator mode: ${ORCHESTRATOR}`);

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  server.get('/health', async () => {
    let dbOk = false;
    try {
      await db.getPool().query('SELECT 1');
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return { status: dbOk ? 'ok' : 'degraded', db: dbOk, orchestrator: ORCHESTRATOR };
  });

  // -----------------------------------------------------------------------
  // Tenants
  // -----------------------------------------------------------------------

  server.get('/api/tenants', async () => {
    return db.listTenants();
  });

  server.post<{
    Body: { name: string; displayName?: string };
  }>('/api/tenants', async (request, reply) => {
    const { name, displayName } = request.body ?? {};

    if (!name || typeof name !== 'string') {
      reply.status(400);
      return { error: 'Missing or invalid "name"' };
    }

    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name)) {
      reply.status(400);
      return { error: 'Tenant name must be 2-63 chars, lowercase alphanumeric and hyphens' };
    }

    const existing = await db.getTenant(name);
    if (existing) {
      reply.status(409);
      return { error: `Tenant "${name}" already exists` };
    }

    try {
      const config = insforge.getTenantConfig(name);
      const pgHost = config?.insforgeUrl ?? 'unknown';

      const tenant = await db.createTenant(
        name,
        displayName ?? name,
        `tenant-${name}`,
        pgHost
      );

      reply.status(201);
      return tenant;
    } catch (err: any) {
      request.log.error(err, 'Failed to create tenant');
      reply.status(500);
      return { error: 'Tenant creation failed', details: err.message };
    }
  });

  // -----------------------------------------------------------------------
  // Apps
  // -----------------------------------------------------------------------

  // List apps for tenant
  server.get<{
    Params: { tenantName: string };
  }>('/api/tenants/:tenantName/apps', async (request, reply) => {
    const { tenantName } = request.params;

    const tenant = await db.getTenant(tenantName);
    if (!tenant) {
      reply.status(404);
      return { error: `Tenant "${tenantName}" not found` };
    }

    return db.listApps(tenantName);
  });

  // Deploy app (provision schema in tenant's InsForge)
  server.post<{
    Params: { tenantName: string };
    Body: {
      appName: string;
      schemaDef?: object;
    };
  }>('/api/tenants/:tenantName/apps', async (request, reply) => {
    const { tenantName } = request.params;
    const { appName, schemaDef } = request.body ?? {};

    if (!appName || typeof appName !== 'string') {
      reply.status(400);
      return { error: 'Missing or invalid "appName"' };
    }

    const tenant = await db.getTenant(tenantName);
    if (!tenant) {
      reply.status(404);
      return { error: `Tenant "${tenantName}" not found` };
    }

    // Generate app identifiers
    const appId = uuidv4();
    const shortId = appId.replace(/-/g, '').substring(0, 12);

    try {
      // 1. Record in metadata DB
      const app = await db.createApp(tenantName, shortId, appName, schemaDef ?? {});

      // 2. Provision schema in tenant's InsForge PG
      const result = await insforge.provisionAppSchema(
        tenantName,
        appId,
        (schemaDef as any) ?? { tables: {} }
      );

      // 3. Update status
      await db.updateAppStatus(tenantName, shortId, 'deployed');

      // 4. Generate MCP config for agent access
      const mcpConfig = insforge.generateMCPConfig(tenantName, appId);

      const updated = await db.getApp(tenantName, shortId);
      reply.status(201);
      return {
        ...updated,
        appId,
        schemaName: result.schemaName,
        insforgeUrl: result.insforgeUrl,
        mcpConfig,
      };
    } catch (err: any) {
      request.log.error(err, 'Failed to deploy app');
      try {
        await db.updateAppStatus(tenantName, shortId, 'failed');
      } catch { /* best effort */ }
      reply.status(500);
      return { error: 'App deployment failed', details: err.message };
    }
  });

  // Delete app (drop schema)
  server.delete<{
    Params: { tenantName: string; shortId: string };
  }>('/api/tenants/:tenantName/apps/:shortId', async (request, reply) => {
    const { tenantName, shortId } = request.params;

    const app = await db.getApp(tenantName, shortId);
    if (!app) {
      reply.status(404);
      return { error: `App "${shortId}" not found in tenant "${tenantName}"` };
    }

    try {
      // Reconstruct appId from shortId for schema name
      // In production, store full appId in the apps table
      await insforge.destroyAppSchema(tenantName, shortId);
      await db.deleteApp(tenantName, shortId);
      return { deleted: true, shortId };
    } catch (err: any) {
      request.log.error(err, 'Failed to delete app');
      reply.status(500);
      return { error: 'App deletion failed', details: err.message };
    }
  });

  // Get app schemas in a tenant's InsForge
  server.get<{
    Params: { tenantName: string };
  }>('/api/tenants/:tenantName/schemas', async (request, reply) => {
    const { tenantName } = request.params;

    try {
      const schemas = await insforge.listAppSchemas(tenantName);
      return { tenantName, schemas };
    } catch (err: any) {
      reply.status(500);
      return { error: 'Failed to list schemas', details: err.message };
    }
  });

  // Get MCP config for an app (for Super Agent integration)
  server.get<{
    Params: { tenantName: string; shortId: string };
  }>('/api/tenants/:tenantName/apps/:shortId/mcp', async (request, reply) => {
    const { tenantName, shortId } = request.params;

    const app = await db.getApp(tenantName, shortId);
    if (!app) {
      reply.status(404);
      return { error: `App "${shortId}" not found` };
    }

    const mcpConfig = insforge.generateMCPConfig(tenantName, shortId);
    if (!mcpConfig) {
      reply.status(404);
      return { error: `No InsForge config for tenant "${tenantName}"` };
    }

    return { appShortId: shortId, mcpConfig };
  });

  // -----------------------------------------------------------------------
  // Start server
  // -----------------------------------------------------------------------

  try {
    await server.listen({ port: PORT, host: '0.0.0.0' });
    server.log.info(`App Host API listening on port ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
