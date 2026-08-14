import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { syncWorkspaceToS3 } from '../workspace-sync.js';

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
