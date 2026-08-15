import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  restoreWorkspaceFromS3,
  syncWorkspaceToS3,
} from '../workspace-sync.js';

test('uploads local files and deletes stale remote workspace objects', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-workspace-'));
  await mkdir(join(workspace, 'src'));
  await writeFile(join(workspace, 'src', 'index.ts'), 'export {};\n');
  const commands: unknown[] = [];
  const s3 = {
    async send(command: unknown): Promise<unknown> {
      commands.push(command);
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [
            { Key: 'org/session/src/index.ts' },
            { Key: 'org/session/stale.txt' },
            { Key: 'org/session/__diff__.json' },
          ],
        };
      }
      if (command instanceof DeleteObjectsCommand) return {};
      if (command instanceof PutObjectCommand) return {};
      throw new Error('Unexpected command');
    },
  } as unknown as S3Client;

  try {
    const result = await syncWorkspaceToS3(s3, 'bucket', 'org/session/', workspace);
    assert.deepEqual(result, { uploaded: 1, deleted: 1 });
    const deletion = commands.find(command => command instanceof DeleteObjectsCommand);
    assert.deepEqual(
      (deletion as DeleteObjectsCommand).input.Delete?.Objects,
      [{ Key: 'org/session/stale.txt' }],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('clears the prior workspace before a failed S3 restore', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-restore-'));
  const stalePath = join(workspace, 'previous-tenant.txt');
  await writeFile(stalePath, 'secret');
  const s3 = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) {
        throw new Error('S3 unavailable');
      }
      throw new Error('Unexpected command');
    },
  } as unknown as S3Client;

  try {
    await assert.rejects(
      restoreWorkspaceFromS3(s3, 'bucket', 'org/session/', workspace),
      /S3 unavailable/,
    );
    await assert.rejects(access(stalePath));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('fails the restore when any workspace object cannot be downloaded', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-restore-object-failure-'));
  const s3 = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'org/session/input.txt' }] };
      }
      if (command instanceof GetObjectCommand) throw new Error('download denied');
      throw new Error(`Unexpected command: ${String(command)}`);
    },
  } as unknown as S3Client;

  try {
    await assert.rejects(
      restoreWorkspaceFromS3(s3, 'bucket', 'org/session/', workspace),
      /Workspace restore failed for input\.txt/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('fails the invocation sync when any workspace upload fails', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-upload-failure-'));
  await writeFile(join(workspace, 'result.txt'), 'result');
  const s3 = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) throw new Error('upload denied');
      if (command instanceof ListObjectsV2Command) return { Contents: [] };
      throw new Error('Unexpected command');
    },
  } as unknown as S3Client;

  try {
    await assert.rejects(
      syncWorkspaceToS3(s3, 'bucket', 'org/session/', workspace),
      /Workspace mirror failed for upload:result.txt/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
