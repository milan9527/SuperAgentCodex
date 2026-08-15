import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dedupeGeneratedSkillContext } from '../src/services/agent-skill-context.js';

interface Options {
  baseDir: string;
  bucket?: string;
  region: string;
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgresql://workspace-cleanup:unused@localhost/workspace-cleanup';
  const { config } = await import('../src/config/index.js');
  const options = parseOptions(process.argv.slice(2), {
    baseDir: config.claude.workspaceBaseDir,
    region: config.aws.region,
  });

  const local = await normalizeLocalWorkspaces(options.baseDir);
  const remote = options.bucket
    ? await normalizeS3Workspaces(new S3Client({ region: options.region }), options.bucket)
    : { scanned: 0, changed: 0 };

  console.log(
    `Agent skill context cleanup complete: `
    + `local=${local.changed}/${local.scanned}, s3=${remote.changed}/${remote.scanned}`,
  );
}

function parseOptions(
  args: string[],
  defaults: { baseDir: string; region: string },
): Options {
  const valueAfter = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    baseDir: valueAfter('--base') ?? process.env.AGENT_WORKSPACE_BASE_DIR ?? defaults.baseDir,
    bucket: valueAfter('--bucket'),
    region: valueAfter('--region') ?? process.env.AWS_REGION ?? defaults.region,
  };
}

async function normalizeLocalWorkspaces(
  baseDir: string,
): Promise<{ scanned: number; changed: number }> {
  const files = await findCodexAgentFiles(baseDir);
  let changed = 0;
  for (const file of files) {
    const before = await readFile(file, 'utf-8');
    const after = dedupeGeneratedSkillContext(before);
    if (after === before) continue;
    await writeFile(file, after, 'utf-8');
    changed++;
  }
  return { scanned: files.length, changed };
}

async function findCodexAgentFiles(root: string): Promise<string[]> {
  const results: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile()
        && entry.name.endsWith('.toml')
        && fullPath.includes(`${join('.codex', 'agents')}/`)
      ) {
        results.push(fullPath);
      }
    }
  };
  await walk(root);
  return results;
}

async function normalizeS3Workspaces(
  s3: S3Client,
  bucket: string,
): Promise<{ scanned: number; changed: number }> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
    }));
    for (const object of result.Contents ?? []) {
      if (
        object.Key?.includes('/.codex/agents/')
        && object.Key.endsWith('.toml')
      ) {
        keys.push(object.Key);
      }
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  let changed = 0;
  for (const key of keys) {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const before = await object.Body?.transformToString('utf-8');
    if (before === undefined) continue;
    const after = dedupeGeneratedSkillContext(before);
    if (after === before) continue;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: after,
      ContentType: 'text/plain; charset=utf-8',
    }));
    changed++;
  }
  return { scanned: keys.length, changed };
}

await main();
