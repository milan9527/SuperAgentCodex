/**
 * App Host POC — InsForge Multi-Tenant Deployment Script
 *
 * Deploys the full stack:
 *   1. Docker Compose up (Floci + Traefik + InsForge instances)
 *   2. Wait for all InsForge PG instances to be ready
 *   3. Create S3 buckets and IAM roles in Floci
 *   4. Provision per-app schemas in each tenant's InsForge PG
 */

import { execSync } from 'child_process'
import { Pool } from 'pg'

// Scripts are always run from the poc/ directory (or via npx tsx scripts/src/deploy.ts)
const POC_DIR = process.cwd()

function run(cmd: string, label?: string) {
  try {
    execSync(cmd, { stdio: 'inherit', shell: '/bin/bash', cwd: POC_DIR })
  } catch (err: any) {
    if (label) console.error(`Failed: ${label}`)
    throw err
  }
}

async function waitForPg(host: string, port: number, db: string, user: string, password: string, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const pool = new Pool({ host, port, database: db, user, password })
      await pool.query('SELECT 1')
      await pool.end()
      return
    } catch {
      process.stdout.write('.')
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  throw new Error(`PG at ${host}:${port}/${db} not ready after ${maxRetries * 2}s`)
}

async function waitForHttp(url: string, maxRetries = 60) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3000) })
      if (resp.ok) return
    } catch {
      // ignore
    }
    process.stdout.write('.')
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error(`HTTP ${url} not ready after ${maxRetries * 2}s`)
}

async function main() {
  console.log('=== App Host POC — InsForge Multi-Tenant Deployment ===\n')

  // Step 1: Build InsForge image and start Docker Compose
  console.log('[1/4] Starting Docker Compose (building InsForge image + all services)...')
  console.log('       This may take a few minutes on first run (building InsForge)...\n')
  run('docker compose -f docker-compose.floci.yml up -d --build', 'docker compose up')

  // Step 2: Wait for all tenant PG instances
  console.log('\n[2/4] Waiting for tenant InsForge databases...')
  const tenants = [
    { name: 'alpha', port: 5433, pw: 'alpha_pg_poc_123' },
    { name: 'beta', port: 5434, pw: 'beta_pg_poc_123' },
    { name: 'gamma', port: 5435, pw: 'gamma_pg_poc_123' },
  ]
  for (const t of tenants) {
    process.stdout.write(`  ${t.name}`)
    await waitForPg('localhost', t.port, 'insforge', 'postgres', t.pw)
    console.log(' ✓')
  }

  // Wait for InsForge app services
  console.log('\n  Waiting for InsForge app services...')
  const insforgeEndpoints = [
    { name: 'alpha', port: 7130 },
    { name: 'beta', port: 7230 },
    { name: 'gamma', port: 7330 },
  ]
  for (const ep of insforgeEndpoints) {
    process.stdout.write(`  insforge-${ep.name}`)
    await waitForHttp(`http://localhost:${ep.port}/api/health`)
    console.log(' ✓')
  }

  // Step 3: Setup AWS resources (S3 + IAM) via Floci
  console.log('\n[3/4] Creating S3 buckets and IAM roles in Floci...')
  run('npx tsx scripts/src/setup-aws.ts', 'setup-aws')

  // Step 4: Provision per-app schemas
  console.log('\n[4/4] Provisioning per-app schemas in InsForge instances...')
  run('npx tsx scripts/src/provision-db.ts', 'provision-db')

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('  Deployment Complete!')
  console.log('='.repeat(60))
  console.log()
  console.log('Infrastructure:')
  console.log('  Floci (AWS API):      http://localhost:4566')
  console.log('  App Host API:         http://localhost:3001')
  console.log('  Traefik Dashboard:    http://localhost:8081')
  console.log()
  console.log('InsForge Instances (per-tenant):')
  console.log('  alpha:')
  console.log('    App API:    http://localhost:7130')
  console.log('    Auth:       http://localhost:7131')
  console.log('    PostgREST:  http://localhost:5430')
  console.log('    PG:         localhost:5433 (postgres/alpha_pg_poc_123)')
  console.log('    Deno:       http://localhost:7133')
  console.log('  beta:')
  console.log('    App API:    http://localhost:7230')
  console.log('    Auth:       http://localhost:7231')
  console.log('    PostgREST:  http://localhost:5431')
  console.log('    PG:         localhost:5434 (postgres/beta_pg_poc_123)')
  console.log('    Deno:       http://localhost:7233')
  console.log('  gamma:')
  console.log('    App API:    http://localhost:7330')
  console.log('    Auth:       http://localhost:7331')
  console.log('    PostgREST:  http://localhost:5432')
  console.log('    PG:         localhost:5435 (postgres/gamma_pg_poc_123)')
  console.log('    Deno:       http://localhost:7333')
  console.log()
  console.log('Next steps:')
  console.log('  1. Seed sample data:  npx tsx scripts/src/seed.ts')
  console.log('  2. Access PostgREST:  curl http://localhost:5430/schedules')
  console.log('  3. Access InsForge:   curl http://localhost:7130/api/health')
}

main().catch(err => {
  console.error('\nDeployment failed:', err.message)
  process.exit(1)
})
