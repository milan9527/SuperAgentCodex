/**
 * Provision per-app schemas in each tenant's InsForge PostgreSQL.
 *
 * For each app:
 *   1. Create schema: app_{shortId}
 *   2. Grant PostgREST roles (anon, authenticated) access to the schema
 *   3. Create business tables defined in schemaDef
 *   4. Notify PostgREST to reload schema cache
 */

import { Pool } from 'pg'

interface AppDef {
  shortId: string
  name: string
  schemaDef: {
    tables: Record<string, { columns: Record<string, string> }>
  }
}

interface TenantDef {
  name: string
  pgPort: number
  pgPassword: string
  apps: AppDef[]
}

const TENANTS: TenantDef[] = [
  {
    name: 'alpha',
    pgPort: 5433,
    pgPassword: 'alpha_pg_poc_123',
    apps: [
      {
        shortId: '550e8400e29b',
        name: 'schedule-app',
        schemaDef: {
          tables: {
            schedules: {
              columns: {
                id: 'serial PRIMARY KEY',
                channel: 'text',
                time_slot: 'text',
                client_name: 'text',
                start_date: 'date',
                end_date: 'date',
                budget: 'numeric',
                status: "text DEFAULT 'draft'",
                created_at: 'timestamptz DEFAULT now()',
              },
            },
          },
        },
      },
    ],
  },
  {
    name: 'beta',
    pgPort: 5434,
    pgPassword: 'beta_pg_poc_123',
    apps: [
      {
        shortId: '4d5e6f7a8b9c',
        name: 'crm-app',
        schemaDef: {
          tables: {
            customers: {
              columns: {
                id: 'serial PRIMARY KEY',
                name: 'text NOT NULL',
                industry: 'text',
                contact: 'text',
                budget: 'numeric DEFAULT 0',
                status: "text DEFAULT 'active'",
                created_at: 'timestamptz DEFAULT now()',
              },
            },
          },
        },
      },
    ],
  },
  {
    name: 'gamma',
    pgPort: 5435,
    pgPassword: 'gamma_pg_poc_123',
    apps: [
      {
        shortId: '9a0b1c2d3e4f',
        name: 'dashboard-app',
        schemaDef: {
          tables: {
            projects: {
              columns: {
                id: 'serial PRIMARY KEY',
                name: 'text NOT NULL',
                budget: 'numeric DEFAULT 0',
                status: "text DEFAULT 'active'",
                owner: 'text',
                created_at: 'timestamptz DEFAULT now()',
              },
            },
          },
        },
      },
    ],
  },
]

async function provisionApp(pool: Pool, app: AppDef, tenantName: string) {
  const schemaName = `app_${app.shortId}`

  // 1. Create schema
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`)
  console.log(`  Schema "${schemaName}" created`)

  // 2. Grant PostgREST roles access (matches InsForge orchestrator pattern)
  await pool.query(`
    GRANT USAGE ON SCHEMA "${schemaName}" TO anon, authenticated, project_admin;
    GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON TABLES TO authenticated, project_admin;
    ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT ALL ON SEQUENCES TO authenticated, project_admin;
    GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA "${schemaName}" GRANT SELECT ON TABLES TO anon;
  `)
  console.log(`  PostgREST roles granted on "${schemaName}"`)

  // 3. Create business tables
  for (const [tableName, tableDef] of Object.entries(app.schemaDef.tables)) {
    const cols = Object.entries(tableDef.columns)
      .map(([name, type]) => `"${name}" ${type}`)
      .join(', ')
    await pool.query(`CREATE TABLE IF NOT EXISTS "${schemaName}"."${tableName}" (${cols})`)
    console.log(`  Table "${schemaName}"."${tableName}" created`)
  }

  // 4. Re-grant on newly created tables (in case DEFAULT PRIVILEGES didn't cover them)
  await pool.query(`
    GRANT ALL ON ALL TABLES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schemaName}" TO authenticated, project_admin;
    GRANT SELECT ON ALL TABLES IN SCHEMA "${schemaName}" TO anon;
  `)

  // 5. Notify PostgREST to reload schema cache
  await pool.query(`NOTIFY pgrst, 'reload schema'`)
  console.log(`  PostgREST notified to reload`)
}

async function main() {
  console.log('=== Provisioning per-app schemas in InsForge instances ===\n')

  for (const tenant of TENANTS) {
    console.log(`[${tenant.name}]`)

    const pool = new Pool({
      host: 'localhost',
      port: tenant.pgPort,
      database: 'insforge',
      user: 'postgres',
      password: tenant.pgPassword,
    })

    for (const app of tenant.apps) {
      await provisionApp(pool, app, tenant.name)
    }

    await pool.end()
    console.log()
  }

  console.log('Done. All app schemas provisioned.')
  console.log()
  console.log('PostgREST access (per-tenant):')
  console.log('  alpha schedules:     curl http://localhost:5430/schedules')
  console.log('  beta customers: curl http://localhost:5431/customers')
  console.log('  gamma projects:   curl http://localhost:5432/projects')
  console.log()
  console.log('Note: PostgREST needs PGRST_DB_SCHEMA to include app schemas.')
  console.log('      For POC, access data via InsForge API or direct PG connection.')
}

main().catch(err => {
  console.error('Provision failed:', err)
  process.exit(1)
})
