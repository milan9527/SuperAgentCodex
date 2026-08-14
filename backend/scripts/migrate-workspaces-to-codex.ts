import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createReadStream, existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

interface Options {
  baseDir: string;
  bucket?: string;
  region: string;
}

const CANONICAL_ROOTS = new Set([
  'AGENTS.md',
  '.agents',
  '.codex',
  '.runtime',
  '.workspace-manifest.json',
]);

async function main(): Promise<void> {
  // WorkspaceManager shares the backend config module, whose schema requires a
  // DATABASE_URL even though this migration never opens a database connection.
  process.env.DATABASE_URL ??= 'postgresql://workspace-migration:unused@localhost/workspace-migration';
  const [{ config }, { WorkspaceManager }] = await Promise.all([
    import('../src/config/index.js'),
    import('../src/services/workspace-manager.js'),
  ]);
  const options = parseOptions(process.argv.slice(2), {
    baseDir: config.claude.workspaceBaseDir,
    region: config.aws.region,
  });
  const manager = new WorkspaceManager(options.baseDir, undefined, 'codex');
  const s3 = options.bucket ? new S3Client({ region: options.region }) : undefined;
  const workspaces = await findSessionWorkspaces(options.baseDir);
  let migrated = 0;
  let unchanged = 0;
  let failed = 0;

  for (const workspacePath of workspaces) {
    try {
      const changed = await manager.migrateWorkspaceToActiveLayout(workspacePath);
      if (options.bucket && s3) {
        const { orgId, scopeId, sessionId } = parseSessionPath(options.baseDir, workspacePath);
        await migrateS3Workspace(
          s3,
          options.bucket,
          `${orgId}/${scopeId}/${sessionId}/`,
          workspacePath,
        );
      }
      if (changed) migrated++;
      else unchanged++;
      console.log(`${changed ? 'migrated' : 'verified'} ${workspacePath}`);
    } catch (error) {
      failed++;
      console.error(
        `failed ${workspacePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(
    `Codex workspace migration complete: migrated=${migrated}, `
    + `verified=${unchanged}, failed=${failed}, total=${workspaces.length}`,
  );
  if (failed > 0) process.exitCode = 1;
}

function parseOptions(
  args: string[],
  defaults: { baseDir: string; region: string },
): Options {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const detectedBase = existsSync('/tmp/super-agent-local-workspaces')
    ? '/tmp/super-agent-local-workspaces'
    : defaults.baseDir;
  return {
    baseDir: valueAfter('--base') ?? process.env.AGENT_WORKSPACE_BASE_DIR ?? detectedBase,
    bucket: valueAfter('--bucket'),
    region: valueAfter('--region') ?? process.env.AWS_REGION ?? defaults.region,
  };
}

async function findSessionWorkspaces(baseDir: string): Promise<string[]> {
  const results: string[] = [];
  const orgs = await readDirectories(baseDir);
  for (const org of orgs) {
    const scopes = await readDirectories(join(baseDir, org));
    for (const scope of scopes) {
      const sessionsDir = join(baseDir, org, scope, 'sessions');
      for (const session of await readDirectories(sessionsDir)) {
        results.push(join(sessionsDir, session));
      }
    }
  }
  return results;
}

async function readDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

function parseSessionPath(
  baseDir: string,
  workspacePath: string,
): { orgId: string; scopeId: string; sessionId: string } {
  const parts = relative(baseDir, workspacePath).split('/');
  if (parts.length !== 4 || parts[2] !== 'sessions') {
    throw new Error(`Unexpected session workspace path: ${workspacePath}`);
  }
  return {
    orgId: parts[0]!,
    scopeId: parts[1]!,
    sessionId: parts[3]!,
  };
}

async function migrateS3Workspace(
  s3: S3Client,
  bucket: string,
  prefix: string,
  workspacePath: string,
): Promise<void> {
  for (const filePath of await listCanonicalFiles(workspacePath)) {
    const fileStat = await stat(filePath);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}${relative(workspacePath, filePath)}`,
      Body: createReadStream(filePath),
      ContentLength: fileStat.size,
    }));
  }

  const legacyKeys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of result.Contents ?? []) {
      if (!object.Key) continue;
      const workspaceRelative = object.Key.slice(prefix.length);
      if (workspaceRelative === 'CLAUDE.md' || workspaceRelative.startsWith('.claude/')) {
        legacyKeys.push(object.Key);
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  for (let index = 0; index < legacyKeys.length; index += 1_000) {
    const batch = legacyKeys.slice(index, index + 1_000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Quiet: true,
        Objects: batch.map(Key => ({ Key })),
      },
    }));
  }
}

async function listCanonicalFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      const rootName = relative(root, fullPath).split('/')[0] ?? basename(fullPath);
      if (!CANONICAL_ROOTS.has(rootName)) continue;
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile()) results.push(fullPath);
    }
  };
  await walk(root);
  return results;
}

await main();
