import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { execFileSync } from 'node:child_process';
import fs, { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const WORKSPACE_DIR = '/workspace';
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.env',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'bower_components',
  '.gradle',
  'target',
  '.cargo',
]);

export interface WorkspaceSyncResult {
  uploaded: number;
  deleted: number;
}

export async function restoreWorkspaceFromS3(
  s3: S3Client,
  bucket: string,
  prefix: string,
  workspaceDir = WORKSPACE_DIR,
): Promise<number> {
  clearWorkspace(workspaceDir);
  const keys = await listKeys(s3, bucket, prefix);
  const remoteRelativePaths = new Set(
    keys
      .map(key => key.slice(prefix.length))
      .filter(relativePath => (
        relativePath !== '__diff__.json' && isSafeWorkspacePath(relativePath)
      )),
  );
  for (const localPath of walkDir(workspaceDir)) {
    const relativePath = path.relative(workspaceDir, localPath);
    if (!remoteRelativePaths.has(relativePath)) {
      fs.rmSync(localPath, { force: true });
    }
  }
  let restored = 0;
  const failures: string[] = [];
  for (const key of keys) {
    const relativePath = key.slice(prefix.length);
    if (!isSafeWorkspacePath(relativePath) || relativePath === '__diff__.json') continue;
    const localPath = path.resolve(workspaceDir, relativePath);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (response.Body) {
        await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(localPath));
        restored++;
      }
    } catch (error) {
      console.warn(`[workspace-sync] Failed to restore ${relativePath}:`, error);
      failures.push(relativePath);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Workspace restore failed for ${failures.join(', ')}`);
  }
  console.log(`[workspace-sync] Restored ${restored}/${keys.length} files`);
  return restored;
}

export function clearWorkspace(workspaceDir = WORKSPACE_DIR): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const entry of fs.readdirSync(workspaceDir)) {
    fs.rmSync(path.join(workspaceDir, entry), { recursive: true, force: true });
  }
}

/**
 * Mirror /workspace to S3, including deletion reconciliation.
 * The generated __diff__.json object is managed separately.
 */
export async function syncWorkspaceToS3(
  s3: S3Client,
  bucket: string,
  prefix: string,
  workspaceDir = WORKSPACE_DIR,
): Promise<WorkspaceSyncResult> {
  const localFiles = walkDir(workspaceDir).filter(
    filePath => fs.statSync(filePath).size <= MAX_FILE_SIZE,
  );
  const localRelativePaths = new Set(
    localFiles.map(filePath => path.relative(workspaceDir, filePath)),
  );
  let uploaded = 0;
  const failures: string[] = [];

  for (const filePath of localFiles) {
    const relativePath = path.relative(workspaceDir, filePath);
    const fileStat = fs.statSync(filePath);
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}${relativePath}`,
        Body: createReadStream(filePath),
        ContentLength: fileStat.size,
      }));
      uploaded++;
    } catch (error) {
      console.warn(`[workspace-sync] Upload failed for ${relativePath}:`, error);
      failures.push(`upload:${relativePath}`);
    }
  }

  const remoteKeys = await listKeys(s3, bucket, prefix);
  const staleKeys = remoteKeys.filter(key => {
    const relativePath = key.slice(prefix.length);
    return relativePath !== '__diff__.json'
      && isSafeWorkspacePath(relativePath)
      && !localRelativePaths.has(relativePath);
  });
  let deleted = 0;
  for (let index = 0; index < staleKeys.length; index += 1_000) {
    const batch = staleKeys.slice(index, index + 1_000);
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Quiet: true,
        Objects: batch.map(Key => ({ Key })),
      },
    }));
    deleted += batch.length - (result.Errors?.length ?? 0);
    for (const error of result.Errors ?? []) {
      console.warn(`[workspace-sync] Delete failed for ${error.Key}: ${error.Message}`);
      failures.push(`delete:${error.Key ?? 'unknown'}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Workspace mirror failed for ${failures.join(', ')}`);
  }

  console.log(
    `[workspace-sync] Mirrored workspace to s3://${bucket}/${prefix} `
    + `(uploaded=${uploaded}, deleted=${deleted})`,
  );
  return { uploaded, deleted };
}

export async function uploadWorkspaceDiff(
  s3: S3Client,
  bucket: string,
  prefix: string,
  workspaceDir = WORKSPACE_DIR,
): Promise<boolean> {
  if (!fs.existsSync(path.join(workspaceDir, '.git'))) return false;
  try {
    execFileSync('git', ['add', '-A'], { cwd: workspaceDir, stdio: 'ignore' });
    const numstat = execFileSync('git', ['diff', '--cached', '--numstat', 'HEAD'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    if (!numstat) return false;

    const statusOutput = execFileSync('git', ['diff', '--cached', '--name-status', 'HEAD'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
    const statuses = new Map<string, string>();
    for (const line of statusOutput.split('\n')) {
      if (!line) continue;
      const [status = 'M', ...parts] = line.split('\t');
      const filePath = parts.at(-1) ?? '';
      statuses.set(
        filePath,
        status.startsWith('A') ? 'added'
          : status.startsWith('D') ? 'deleted'
            : status.startsWith('R') ? 'renamed'
              : 'modified',
      );
    }

    const files = numstat.split('\n').filter(Boolean).map(line => {
      const [insertions = '0', deletions = '0', filePath = ''] = line.split('\t');
      return {
        path: filePath,
        status: statuses.get(filePath) ?? 'modified',
        insertions: insertions === '-' ? 0 : Number(insertions) || 0,
        deletions: deletions === '-' ? 0 : Number(deletions) || 0,
      };
    });
    let diffPatch = execFileSync('git', ['diff', '--cached', 'HEAD'], {
      cwd: workspaceDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (diffPatch.length > 1024 * 1024) {
      diffPatch = `${diffPatch.slice(0, 1024 * 1024)}\n\n... (diff truncated)`;
    }

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${prefix}__diff__.json`,
      Body: JSON.stringify({
        diff_stat: {
          files_changed: files.length,
          insertions: files.reduce((sum, file) => sum + file.insertions, 0),
          deletions: files.reduce((sum, file) => sum + file.deletions, 0),
          files,
        },
        diff_patch: diffPatch,
        created_at: new Date().toISOString(),
      }),
      ContentType: 'application/json',
    }));
    return true;
  } catch (error) {
    console.warn('[workspace-sync] Diff extraction/upload failed:', error);
    return false;
  }
}

async function listKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of result.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);
  return keys;
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(fullPath));
    else if (entry.isFile()) results.push(fullPath);
  }
  return results;
}

function isSafeWorkspacePath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const normalized = path.normalize(relativePath);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) return false;
  return !SKIP_DIRS.has(normalized.split(path.sep)[0] ?? '');
}
