import { Pool, PoolConfig } from 'pg';

let pool: Pool;

export interface TenantRow {
  id: string;
  name: string;
  display_name: string;
  namespace: string;
  pg_host: string;
  created_at: Date;
}

export interface AppRow {
  id: string;
  tenant_name: string;
  short_id: string;
  app_name: string;
  status: string;
  schema_def: object;
  created_at: Date;
}

/**
 * Initialize the database connection and create required tables.
 */
export async function initDB(connectionStr?: string): Promise<void> {
  const connStr = connectionStr || process.env.DATABASE_URL || process.env.META_DB_URL;
  const config: PoolConfig = { connectionString: connStr };

  pool = new Pool(config);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(64) UNIQUE NOT NULL,
      display_name VARCHAR(255) NOT NULL,
      namespace VARCHAR(128) NOT NULL,
      pg_host VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS apps (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_name VARCHAR(64) NOT NULL REFERENCES tenants(name) ON DELETE CASCADE,
      short_id VARCHAR(16) NOT NULL,
      app_name VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'creating',
      schema_def JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_tenant_short
    ON apps (tenant_name, short_id);
  `);

  console.log('[db] Tables initialized');
}

/**
 * Return the underlying Pool (for health-checks etc.).
 */
export function getPool(): Pool {
  if (!pool) throw new Error('Database not initialized. Call initDB() first.');
  return pool;
}

// ---------------------------------------------------------------------------
// Tenant CRUD
// ---------------------------------------------------------------------------

export async function listTenants(): Promise<TenantRow[]> {
  const { rows } = await pool.query<TenantRow>(
    'SELECT id, name, display_name, namespace, pg_host, created_at FROM tenants ORDER BY created_at DESC'
  );
  return rows;
}

export async function getTenant(name: string): Promise<TenantRow | null> {
  const { rows } = await pool.query<TenantRow>(
    'SELECT id, name, display_name, namespace, pg_host, created_at FROM tenants WHERE name = $1',
    [name]
  );
  return rows[0] ?? null;
}

export async function createTenant(
  name: string,
  displayName: string,
  namespace: string,
  pgHost: string
): Promise<TenantRow> {
  const { rows } = await pool.query<TenantRow>(
    `INSERT INTO tenants (name, display_name, namespace, pg_host)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, display_name, namespace, pg_host, created_at`,
    [name, displayName, namespace, pgHost]
  );
  return rows[0];
}

export async function deleteTenant(name: string): Promise<void> {
  await pool.query('DELETE FROM tenants WHERE name = $1', [name]);
}

// ---------------------------------------------------------------------------
// App CRUD
// ---------------------------------------------------------------------------

export async function listApps(tenantName: string): Promise<AppRow[]> {
  const { rows } = await pool.query<AppRow>(
    `SELECT id, tenant_name, short_id, app_name, status, schema_def, created_at
     FROM apps
     WHERE tenant_name = $1
     ORDER BY created_at DESC`,
    [tenantName]
  );
  return rows;
}

export async function getApp(
  tenantName: string,
  shortId: string
): Promise<AppRow | null> {
  const { rows } = await pool.query<AppRow>(
    `SELECT id, tenant_name, short_id, app_name, status, schema_def, created_at
     FROM apps
     WHERE tenant_name = $1 AND short_id = $2`,
    [tenantName, shortId]
  );
  return rows[0] ?? null;
}

export async function createApp(
  tenantName: string,
  shortId: string,
  appName: string,
  schemaDef: object
): Promise<AppRow> {
  const { rows } = await pool.query<AppRow>(
    `INSERT INTO apps (tenant_name, short_id, app_name, status, schema_def)
     VALUES ($1, $2, $3, 'creating', $4)
     RETURNING id, tenant_name, short_id, app_name, status, schema_def, created_at`,
    [tenantName, shortId, appName, JSON.stringify(schemaDef)]
  );
  return rows[0];
}

export async function updateAppStatus(
  tenantName: string,
  shortId: string,
  status: string
): Promise<void> {
  await pool.query(
    'UPDATE apps SET status = $1 WHERE tenant_name = $2 AND short_id = $3',
    [status, tenantName, shortId]
  );
}

export async function deleteApp(
  tenantName: string,
  shortId: string
): Promise<void> {
  await pool.query(
    'DELETE FROM apps WHERE tenant_name = $1 AND short_id = $2',
    [tenantName, shortId]
  );
}
