/**
 * InsForge Integration Module
 *
 * Manages per-app schemas within a tenant's InsForge PostgreSQL instance.
 * Each tenant has its own InsForge instance; each app gets a schema within it.
 *
 * This replaces the K8s-based deployment for Docker/POC mode.
 */

import { Pool } from 'pg';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TenantInsForgeConfig {
  name: string;
  pgHost: string;
  pgPort: number;
  pgUser: string;
  pgPassword: string;
  pgDb: string;
  insforgeUrl: string;  // InsForge App API URL (internal)
  jwtSecret: string;
}

export interface ProvisionAppResult {
  schemaName: string;
  insforgeUrl: string;
  postgrestUrl: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Tenant registry (configured via environment)
// ---------------------------------------------------------------------------

function loadTenantConfigs(): Map<string, TenantInsForgeConfig> {
  const configs = new Map<string, TenantInsForgeConfig>();

  // Load from environment variables
  // Format: TENANT_{NAME}_PG_HOST, TENANT_{NAME}_PG_PORT, etc.
  // For POC, we hardcode the known tenants from docker-compose
  const tenants: TenantInsForgeConfig[] = [
    {
      name: 'alpha',
      pgHost: process.env.INSFORGE_DUNHE_PG_HOST || 'pg-alpha',
      pgPort: parseInt(process.env.INSFORGE_DUNHE_PG_PORT || '5432'),
      pgUser: 'postgres',
      pgPassword: process.env.INSFORGE_DUNHE_PG_PASSWORD || 'alpha_pg_poc_123',
      pgDb: 'insforge',
      insforgeUrl: process.env.INSFORGE_DUNHE_URL || 'http://insforge-alpha:7130',
      jwtSecret: 'alpha-jwt-secret-poc-change-me',
    },
    {
      name: 'beta',
      pgHost: process.env.INSFORGE_OTHERMEDIA_PG_HOST || 'pg-beta',
      pgPort: parseInt(process.env.INSFORGE_OTHERMEDIA_PG_PORT || '5432'),
      pgUser: 'postgres',
      pgPassword: process.env.INSFORGE_OTHERMEDIA_PG_PASSWORD || 'beta_pg_poc_123',
      pgDb: 'insforge',
      insforgeUrl: process.env.INSFORGE_OTHERMEDIA_URL || 'http://insforge-beta:7130',
      jwtSecret: 'beta-jwt-secret-poc-change-me',
    },
    {
      name: 'gamma',
      pgHost: process.env.INSFORGE_TESTCORP_PG_HOST || 'pg-gamma',
      pgPort: parseInt(process.env.INSFORGE_TESTCORP_PG_PORT || '5432'),
      pgUser: 'postgres',
      pgPassword: process.env.INSFORGE_TESTCORP_PG_PASSWORD || 'gamma_pg_poc_123',
      pgDb: 'insforge',
      insforgeUrl: process.env.INSFORGE_TESTCORP_URL || 'http://insforge-gamma:7130',
      jwtSecret: 'gamma-jwt-secret-poc-change-me',
    },
  ];

  for (const t of tenants) {
    configs.set(t.name, t);
  }

  return configs;
}

const tenantConfigs = loadTenantConfigs();

// ---------------------------------------------------------------------------
// Schema management
// ---------------------------------------------------------------------------

/**
 * Generate a schema name for an app (matches Super Agent's insforge-orchestrator pattern).
 */
function appSchemaName(appId: string): string {
  return `app_${appId.replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Get a PG pool for a specific tenant's InsForge database.
 */
function getTenantPool(tenantName: string): Pool {
  const config = tenantConfigs.get(tenantName);
  if (!config) throw new Error(`Unknown tenant: ${tenantName}`);

  return new Pool({
    host: config.pgHost,
    port: config.pgPort,
    user: config.pgUser,
    password: config.pgPassword,
    database: config.pgDb,
    max: 3,
  });
}

/**
 * Provision a new app schema within a tenant's InsForge instance.
 *
 * Steps:
 *   1. Create PG schema
 *   2. Grant PostgREST roles access
 *   3. Create tables from schemaDef
 *   4. Notify PostgREST to reload
 */
export async function provisionAppSchema(
  tenantName: string,
  appId: string,
  schemaDef: { tables?: Record<string, { columns: Record<string, string> }> }
): Promise<ProvisionAppResult> {
  const config = tenantConfigs.get(tenantName);
  if (!config) throw new Error(`Unknown tenant: ${tenantName}`);

  const schemaName = appSchemaName(appId);
  const apiKey = `ik_app_${crypto.randomBytes(16).toString('hex')}`;
  const pool = getTenantPool(tenantName);

  try {
    // 1. Create schema
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    console.log(`[insforge] Schema "${schemaName}" created in tenant "${tenantName}"`);

    // 2. Grant PostgREST roles
    await pool.query(`
      GRANT USAGE ON SCHEMA "${schemaName}" TO anon, authenticated, project_admin;
      GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
      GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON TABLES TO authenticated, project_admin;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON SEQUENCES TO authenticated, project_admin;
      GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
      ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT ON TABLES TO anon;
    `);

    // 3. Create tables from schemaDef
    if (schemaDef.tables) {
      for (const [tableName, tableDef] of Object.entries(schemaDef.tables)) {
        const cols = Object.entries(tableDef.columns)
          .map(([name, type]) => `"${name}" ${type}`)
          .join(', ');
        await pool.query(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (${cols})`);
        console.log(`[insforge] Table "${schemaName}"."${tableName}" created`);
      }

      // Re-grant on newly created tables
      await pool.query(`
        GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
        GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
      `);
    }

    // 4. Notify PostgREST
    await pool.query(`NOTIFY pgrst, 'reload schema'`);

    return {
      schemaName,
      insforgeUrl: config.insforgeUrl,
      postgrestUrl: config.insforgeUrl.replace(':7130', ':5430'), // approximate
      apiKey,
    };
  } finally {
    await pool.end();
  }
}

/**
 * Drop an app's schema (irreversible).
 */
export async function destroyAppSchema(
  tenantName: string,
  appId: string
): Promise<void> {
  const schemaName = appSchemaName(appId);
  const pool = getTenantPool(tenantName);

  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await pool.query(`NOTIFY pgrst, 'reload schema'`);
    console.log(`[insforge] Schema "${schemaName}" destroyed in tenant "${tenantName}"`);
  } finally {
    await pool.end();
  }
}

/**
 * List all app schemas in a tenant's InsForge instance.
 */
export async function listAppSchemas(tenantName: string): Promise<string[]> {
  const pool = getTenantPool(tenantName);

  try {
    const { rows } = await pool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'app_%'
      ORDER BY schema_name
    `);
    return rows.map(r => r.schema_name);
  } finally {
    await pool.end();
  }
}

/**
 * Get the InsForge config for a tenant (for MCP integration).
 */
export function getTenantConfig(tenantName: string): TenantInsForgeConfig | undefined {
  return tenantConfigs.get(tenantName);
}

/**
 * Generate MCP server config for an agent to access an app's data.
 * This matches the pattern in Super Agent's agent-app-data-resolver.ts.
 */
export function generateMCPConfig(tenantName: string, appId: string) {
  const config = tenantConfigs.get(tenantName);
  if (!config) return null;

  const schemaName = appSchemaName(appId);

  return {
    command: 'npx',
    args: ['-y', 'insforge-mcp@latest', '--url', config.insforgeUrl],
    env: {
      INSFORGE_URL: config.insforgeUrl,
      INSFORGE_SCHEMA: schemaName,
    },
  };
}
