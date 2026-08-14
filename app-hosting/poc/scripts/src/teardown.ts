/**
 * Teardown: stop and remove all POC containers and volumes.
 */

import { execSync } from 'child_process'

// Scripts are always run from the poc/ directory
const POC_DIR = process.cwd()

console.log('=== App Host POC (InsForge) — Teardown ===\n')

console.log('Stopping and removing all containers, volumes, networks...')
execSync(`docker compose -f docker-compose.floci.yml down -v --remove-orphans`, {
  stdio: 'inherit',
  shell: '/bin/bash',
  cwd: POC_DIR,
})

console.log('\nDone. All POC resources cleaned up.')
console.log('To redeploy: npx tsx scripts/src/deploy.ts')
