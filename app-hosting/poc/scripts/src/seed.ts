/**
 * Seed sample data into each tenant's InsForge per-app schemas.
 */

import { Pool } from 'pg'

interface SeedConfig {
  name: string
  port: number
  password: string
  schema: string
  table: string
  rows: Record<string, any>[]
}

const SEEDS: SeedConfig[] = [
  {
    name: 'Tenant A — Schedule Manager',
    port: 5433,
    password: 'alpha_pg_poc_123',
    schema: 'app_550e8400e29b',
    table: 'schedules',
    rows: [
      { channel: 'Channel-1 Prime', time_slot: '19:00-19:30', client_name: 'Acme Corp', start_date: '2026-06-01', end_date: '2026-08-31', budget: 1200000, status: 'active' },
      { channel: 'Channel-2 Business', time_slot: '20:00-20:30', client_name: 'Globe Motors', start_date: '2026-07-01', end_date: '2026-09-30', budget: 800000, status: 'pending' },
      { channel: 'Channel-1 Evening', time_slot: '18:55-19:00', client_name: 'Summit Realty', start_date: '2026-06-15', end_date: '2026-12-31', budget: 2500000, status: 'active' },
      { channel: 'Channel-3 Entertainment', time_slot: '20:00-22:00', client_name: 'ShopNow Inc', start_date: '2026-08-01', end_date: '2026-11-30', budget: 600000, status: 'draft' },
    ],
  },
  {
    name: 'Tenant B — CRM',
    port: 5434,
    password: 'beta_pg_poc_123',
    schema: 'app_4d5e6f7a8b9c',
    table: 'customers',
    rows: [
      { name: 'Nova Tech', industry: 'Technology', contact: 'Alice Zhang', budget: 500000, status: 'active' },
      { name: 'Green Foods', industry: 'FMCG', contact: 'Bob Li', budget: 300000, status: 'active' },
      { name: 'Apex Finance', industry: 'Finance', contact: 'Carol Wang', budget: 1200000, status: 'active' },
      { name: 'EduPlus', industry: 'Education', contact: 'David Zhao', budget: 200000, status: 'active' },
      { name: 'Horizon Properties', industry: 'Real Estate', contact: 'Eve Chen', budget: 800000, status: 'active' },
    ],
  },
  {
    name: 'Tenant C — Dashboard',
    port: 5435,
    password: 'gamma_pg_poc_123',
    schema: 'app_9a0b1c2d3e4f',
    table: 'projects',
    rows: [
      { name: 'Annual Brand Campaign', budget: 1500000, status: 'active', owner: 'Alice' },
      { name: 'Product Launch', budget: 800000, status: 'done', owner: 'Bob' },
      { name: 'Summer Promotion', budget: 2000000, status: 'active', owner: 'Carol' },
      { name: 'Brand Monitoring', budget: 300000, status: 'active', owner: 'David' },
      { name: 'Industry Conference', budget: 500000, status: 'done', owner: 'Eve' },
      { name: 'Q3 Performance Ads', budget: 600000, status: 'active', owner: 'Alice' },
    ],
  },
]

async function main() {
  console.log('=== Seeding sample data into InsForge instances ===\n')

  for (const seed of SEEDS) {
    console.log(`[${seed.name}]`)
    const pool = new Pool({
      host: 'localhost',
      port: seed.port,
      database: 'insforge',
      user: 'postgres',
      password: seed.password,
    })

    // Check if data already exists
    try {
      const count = await pool.query(`SELECT COUNT(*) FROM "${seed.schema}"."${seed.table}"`)
      if (Number(count.rows[0].count) > 0) {
        console.log(`  Already has ${count.rows[0].count} rows, skipping`)
        await pool.end()
        continue
      }
    } catch (err: any) {
      console.log(`  Table not found (run provision-db first): ${err.message}`)
      await pool.end()
      continue
    }

    for (const row of seed.rows) {
      const keys = Object.keys(row).map(k => `"${k}"`)
      const values = Object.values(row)
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
      await pool.query(
        `INSERT INTO "${seed.schema}"."${seed.table}" (${keys.join(', ')}) VALUES (${placeholders})`,
        values
      )
    }
    console.log(`  Inserted ${seed.rows.length} rows into "${seed.schema}"."${seed.table}"`)

    // Notify PostgREST to pick up new data
    await pool.query(`NOTIFY pgrst, 'reload schema'`)

    await pool.end()
    console.log()
  }

  console.log('Done. Sample data seeded.')
  console.log()
  console.log('Verify via direct PG:')
  console.log('  psql -h localhost -p 5433 -U postgres -d insforge -c \'SELECT * FROM app_550e8400e29b.schedules;\'')
  console.log()
  console.log('Verify via InsForge API:')
  console.log('  curl http://localhost:7130/api/tables/app_550e8400e29b/schedules/records')
}

main().catch(err => {
  console.error('Seed failed:', err)
  process.exit(1)
})
