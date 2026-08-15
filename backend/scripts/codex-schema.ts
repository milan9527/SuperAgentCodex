import { execFileSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDir, '..', '..');
const targetDir = join(repositoryRoot, 'codex-sdk-migration', 'app-server-schema');
const schemaFiles = [
  'codex_app_server_protocol.schemas.json',
  'codex_app_server_protocol.v2.schemas.json',
] as const;
const checkOnly = process.argv.includes('--check');
const executable = process.env.CODEX_EXECUTABLE ?? 'codex';
const generatedDir = await mkdtemp(join(tmpdir(), 'super-agent-codex-schema-'));

try {
  execFileSync(executable, ['app-server', 'generate-json-schema', '--out', generatedDir], {
    stdio: 'inherit',
  });
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();

  if (checkOnly) {
    const expectedVersion = (await readFile(join(targetDir, 'CODEX_VERSION'), 'utf8')).trim();
    if (expectedVersion !== version) {
      throw new Error(`Codex version mismatch: expected ${expectedVersion}, got ${version}`);
    }
    for (const file of schemaFiles) {
      const [expected, actual] = await Promise.all([
        readFile(join(targetDir, file), 'utf8'),
        readFile(join(generatedDir, file), 'utf8'),
      ]);
      if (stableJson(expected) !== stableJson(actual)) {
        throw new Error(`Generated Codex app-server schema differs: ${file}`);
      }
    }
    console.log(`Codex app-server schema matches ${version}`);
  } else {
    await mkdir(targetDir, { recursive: true });
    for (const file of schemaFiles) {
      const generated = await readFile(join(generatedDir, file), 'utf8');
      await writeFile(join(targetDir, file), `${stableJson(generated)}\n`, 'utf8');
    }
    await writeFile(join(targetDir, 'CODEX_VERSION'), `${version}\n`, 'utf8');
    console.log(`Generated Codex app-server schema for ${version}`);
  }
} finally {
  await rm(generatedDir, { recursive: true, force: true });
}

function stableJson(json: string): string {
  return JSON.stringify(sortJson(JSON.parse(json)), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
