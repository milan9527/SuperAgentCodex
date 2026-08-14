/**
 * InsForge Orchestrator Service (Shared Instance Mode)
 *
 * Manages per-app backend schemas within a single shared InsForge instance.
 * Each published app gets its own PostgreSQL schema for complete data isolation,
 * while sharing the underlying InsForge infrastructure (Auth, Storage, Functions, MCP).
 *
 * Architecture:
 *   1 InsForge Docker Compose stack (shared)
 *     ├── PostgreSQL with per-app schemas (app_{short_id})
 *     ├── PostgREST (auto-generated REST API)
 *     ├── Auth service (shared user pool, per-app roles)
 *     ├── Storage (per-app bucket prefixes)
 *     ├── Deno Functions (per-app function namespaces)
 *     └── MCP Server (agent access point)
 *
 * The App Builder Agent uses InsForge MCP to create tables, configure auth,
 * and deploy functions — all through natural language.
 */

import crypto from 'crypto';
import { prisma } from '../config/database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InstanceType = 'nano' | 'micro' | 'small' | 'medium' | 'large';
export type ProjectStatus = 'provisioning' | 'active' | 'paused' | 'error' | 'destroyed';

export interface ProvisionConfig {
  appId: string;
  orgId: string;
  projectName: string;
  instanceType?: InstanceType;
}

export interface InsForgeProjectInfo {
  id: string;
  appId: string;
  projectName: string;
  status: ProjectStatus;
  accessHost: string;
  apiKey: string;
  mcpEndpoint: string;
  schemaName: string;
  ports: PortAllocation;
}

export interface PortAllocation {
  postgres: number;
  postgrest: number;
  app: number;
  auth: number;
  deno: number;
}

export interface HealthStatus {
  healthy: boolean;
  services: {
    postgres: boolean;
    app: boolean;
    postgrest: boolean;
    deno: boolean;
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Shared InsForge instance connection details (from config) */
import { config } from '../config/index.js';

const INSFORGE_HOST = config.insforge.host;
const INSFORGE_PORT_APP = config.insforge.portApp;
const INSFORGE_PORT_AUTH = config.insforge.portAuth;
const INSFORGE_PORT_POSTGREST = config.insforge.portPostgrest;
const INSFORGE_PORT_POSTGRES = config.insforge.portPostgres;
const INSFORGE_PORT_DENO = config.insforge.portDeno;

/** PostgreSQL connection for schema management */
const INSFORGE_PG_USER = config.insforge.pgUser;
const INSFORGE_PG_PASSWORD = config.insforge.pgPassword;
const INSFORGE_PG_DB = config.insforge.pgDb;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a schema name for an app.
 * Format: app_{first 8 chars of UUID} — safe for PostgreSQL identifiers.
 */
function appSchemaName(appId: string): string {
  return `app_${appId.replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Execute a SQL statement against the shared InsForge PostgreSQL.
 * Uses execFile with stdin pipe to avoid shell quoting issues.
 */
async function execSQL(sql: string): Promise<string> {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const { stdout } = await execFileAsync('psql', [
    '-h', INSFORGE_HOST,
    '-p', String(INSFORGE_PORT_POSTGRES),
    '-U', INSFORGE_PG_USER,
    '-d', INSFORGE_PG_DB,
    '--no-psqlrc',
    '-t',
    '-c', sql,
  ], {
    timeout: 15_000,
    env: { ...process.env, PGPASSWORD: INSFORGE_PG_PASSWORD },
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class InsForgeOrchestratorService {

  private get sharedPorts(): PortAllocation {
    return {
      postgres: INSFORGE_PORT_POSTGRES,
      postgrest: INSFORGE_PORT_POSTGREST,
      app: INSFORGE_PORT_APP,
      auth: INSFORGE_PORT_AUTH,
      deno: INSFORGE_PORT_DENO,
    };
  }

  /**
   * Provision a new schema for an app within the shared InsForge instance.
   *
   * Steps:
   *   1. Create a PostgreSQL schema for the app
   *   2. Grant appropriate permissions
   *   3. Record in app_backend_instances table
   */
  async provisionProject(cfg: ProvisionConfig): Promise<InsForgeProjectInfo> {
    const { appId, orgId, projectName, instanceType = 'nano' } = cfg;

    // Check if app already has a backend
    const existing = await prisma.app_backend_instances.findUnique({ where: { app_id: appId } });
    if (existing && existing.status !== 'destroyed') {
      throw new Error(`App ${appId} already has a backend instance (status: ${existing.status})`);
    }

    const schemaName = appSchemaName(appId);
    const apiKey = `ik_app_${crypto.randomBytes(16).toString('hex')}`;
    const ports = this.sharedPorts;

    try {
      // 1. Create isolated schema
      await execSQL(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);

      // 2. Grant permissions to PostgREST roles
      await execSQL(`
        GRANT USAGE ON SCHEMA "${schemaName}" TO anon, authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON TABLES TO authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON SEQUENCES TO authenticated;
        GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
        ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT ON TABLES TO anon;
      `);

      // 3. Create DB record
      const instance = await prisma.app_backend_instances.create({
        data: {
          app_id: appId,
          org_id: orgId,
          project_name: projectName,
          provider: 'insforge',
          status: 'active',
          instance_type: instanceType,
          host: INSFORGE_HOST,
          port_postgres: ports.postgres,
          port_app: ports.app,
          port_auth: ports.auth,
          port_deno: ports.deno,
          port_postgrest: ports.postgrest,
          api_key: apiKey,
          mcp_endpoint: `http://${INSFORGE_HOST}:${ports.app}/mcp`,
          last_active_at: new Date(),
        },
      });

      // 4. Update published_apps backend_type
      await prisma.published_apps.update({
        where: { id: appId },
        data: { backend_type: 'insforge' },
      });

      console.log(`[InsForge] Provisioned schema "${schemaName}" for app ${appId}`);

      return {
        id: instance.id,
        appId,
        projectName,
        status: 'active',
        accessHost: `http://${INSFORGE_HOST}:${ports.app}`,
        apiKey,
        mcpEndpoint: `http://${INSFORGE_HOST}:${ports.app}/mcp`,
        schemaName,
        ports,
      };
    } catch (err: any) {
      // Record error
      if (existing?.id) {
        await prisma.app_backend_instances.update({
          where: { id: existing.id },
          data: { status: 'error', error_message: err.message?.slice(0, 500) },
        });
      }
      console.error(`[InsForge] Failed to provision schema for app ${appId}:`, err.message);
      throw err;
    }
  }

  /**
   * Pause an app's backend (revoke schema access, mark as paused).
   * Data is preserved — just access is disabled.
   */
  async pauseProject(instanceId: string): Promise<void> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { id: instanceId } });
    if (!instance) throw new Error('Instance not found');
    if (instance.status !== 'active') throw new Error(`Cannot pause instance in status: ${instance.status}`);

    const schemaName = appSchemaName(instance.app_id);

    try {
      // Revoke access (data preserved, just not queryable)
      await execSQL(`
        REVOKE USAGE ON SCHEMA "${schemaName}" FROM anon, authenticated;
      `);

      await prisma.app_backend_instances.update({
        where: { id: instanceId },
        data: { status: 'paused', paused_at: new Date() },
      });

      console.log(`[InsForge] Paused schema "${schemaName}"`);
    } catch (err: any) {
      console.error(`[InsForge] Failed to pause:`, err.message);
      throw err;
    }
  }

  /**
   * Restore a paused app's backend (re-grant schema access).
   */
  async restoreProject(instanceId: string): Promise<InsForgeProjectInfo> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { id: instanceId } });
    if (!instance) throw new Error('Instance not found');
    if (instance.status !== 'paused') throw new Error(`Cannot restore instance in status: ${instance.status}`);

    const schemaName = appSchemaName(instance.app_id);

    try {
      // Re-grant access
      await execSQL(`
        GRANT USAGE ON SCHEMA "${schemaName}" TO anon, authenticated;
        GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated;
        GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
      `);

      await prisma.app_backend_instances.update({
        where: { id: instanceId },
        data: { status: 'active', paused_at: null, last_active_at: new Date() },
      });

      console.log(`[InsForge] Restored schema "${schemaName}"`);

      return {
        id: instance.id,
        appId: instance.app_id,
        projectName: instance.project_name,
        status: 'active',
        accessHost: `http://${instance.host}:${instance.port_app}`,
        apiKey: instance.api_key,
        mcpEndpoint: instance.mcp_endpoint || `http://${instance.host}:${instance.port_app}/mcp`,
        schemaName,
        ports: this.sharedPorts,
      };
    } catch (err: any) {
      console.error(`[InsForge] Failed to restore:`, err.message);
      throw err;
    }
  }

  /**
   * Destroy an app's backend (DROP SCHEMA CASCADE).
   * This is irreversible — all app data is deleted.
   */
  async destroyProject(instanceId: string): Promise<void> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { id: instanceId } });
    if (!instance) throw new Error('Instance not found');

    const schemaName = appSchemaName(instance.app_id);

    try {
      await execSQL(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);

      await prisma.app_backend_instances.update({
        where: { id: instanceId },
        data: { status: 'destroyed' },
      });

      await prisma.published_apps.update({
        where: { id: instance.app_id },
        data: { backend_type: 'none' },
      });

      console.log(`[InsForge] Destroyed schema "${schemaName}"`);
    } catch (err: any) {
      console.error(`[InsForge] Failed to destroy:`, err.message);
      throw err;
    }
  }

  /**
   * Health check — verify the shared InsForge instance is running.
   */
  async healthCheck(instanceId: string): Promise<HealthStatus> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { id: instanceId } });
    if (!instance) throw new Error('Instance not found');

    const checkHttp = async (port: number, path = '/api/health'): Promise<boolean> => {
      try {
        const res = await fetch(`http://${INSFORGE_HOST}:${port}${path}`, {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok;
      } catch {
        return false;
      }
    };

    const checkPg = async (): Promise<boolean> => {
      try {
        await execSQL('SELECT 1;');
        return true;
      } catch {
        return false;
      }
    };

    const [app, postgrest, postgres, deno] = await Promise.all([
      checkHttp(INSFORGE_PORT_APP),
      checkHttp(INSFORGE_PORT_POSTGREST, '/'),
      checkPg(),
      checkHttp(INSFORGE_PORT_DENO).catch(() => false),
    ]);

    return {
      healthy: app && postgrest && postgres,
      services: { postgres, app, postgrest, deno },
    };
  }

  /**
   * Get project info by app ID.
   */
  async getByAppId(appId: string): Promise<InsForgeProjectInfo | null> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { app_id: appId } });
    if (!instance || instance.status === 'destroyed') return null;

    return {
      id: instance.id,
      appId: instance.app_id,
      projectName: instance.project_name,
      status: instance.status as ProjectStatus,
      accessHost: `http://${instance.host}:${instance.port_app}`,
      apiKey: instance.api_key,
      mcpEndpoint: instance.mcp_endpoint || `http://${instance.host}:${instance.port_app}/mcp`,
      schemaName: appSchemaName(instance.app_id),
      ports: this.sharedPorts,
    };
  }

  /**
   * Touch last_active_at.
   */
  async touchActivity(appId: string): Promise<void> {
    await prisma.app_backend_instances.updateMany({
      where: { app_id: appId, status: 'active' },
      data: { last_active_at: new Date() },
    });
  }

  /**
   * Auto-restore if paused, return project info if available.
   */
  async ensureActive(appId: string): Promise<InsForgeProjectInfo | null> {
    const instance = await prisma.app_backend_instances.findUnique({ where: { app_id: appId } });
    if (!instance) return null;

    if (instance.status === 'active') {
      await this.touchActivity(appId);
      return this.getByAppId(appId);
    }

    if (instance.status === 'paused') {
      return this.restoreProject(instance.id);
    }

    return null;
  }

  /**
   * List all instances for an org.
   */
  async listByOrg(orgId: string) {
    return prisma.app_backend_instances.findMany({
      where: { org_id: orgId, status: { not: 'destroyed' } },
      orderBy: { created_at: 'desc' },
      include: { app: { select: { id: true, name: true, icon: true } } },
    });
  }

  /**
   * Get the schema name for an app (utility for other services).
   */
  getSchemaName(appId: string): string {
    return appSchemaName(appId);
  }

  /**
   * List tables in an app's schema.
   */
  async listAppTables(appId: string): Promise<string[]> {
    const schemaName = appSchemaName(appId);
    const result = await execSQL(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = '${schemaName}'
      ORDER BY table_name;
    `);
    // Parse psql output (skip header lines)
    return result
      .split('\n')
      .slice(2) // skip header + separator
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('(') && line !== '');
  }

  /**
   * Get storage usage for an app's schema (in MB).
   */
  async getSchemaSize(appId: string): Promise<number> {
    const schemaName = appSchemaName(appId);
    try {
      const result = await execSQL(`
        SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(table_name)::regclass)), 0) as size_bytes
        FROM information_schema.tables
        WHERE table_schema = '${schemaName}';
      `);
      const match = result.match(/(\d+)/);
      return match?.[1] ? parseInt(match[1]) / (1024 * 1024) : 0;
    } catch {
      return 0;
    }
  }
}

export const insforgeOrchestrator = new InsForgeOrchestratorService();
