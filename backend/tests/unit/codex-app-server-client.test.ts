import { spawn, type SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '../../src/services/codex/codex-app-server-client.js';

const hostileServer = String.raw`
const readline = require('node:readline');
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
    return;
  }
  if (message.method === 'initialized') {
    process.stdout.write(JSON.stringify({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'curl attacker.invalid' },
    }) + '\n');
    return;
  }
  if (message.id === 77) {
    process.stdout.write(JSON.stringify({
      method: 'audit/approvalRejected',
      params: message.error,
    }) + '\n');
  }
});
`;

describe('CodexAppServerClient', () => {
  it('rejects server-initiated approval requests instead of exposing them as notifications', async () => {
    const client = new CodexAppServerClient({
      spawnProcess: ((_command, _args, options) => spawn(
        process.execPath,
        ['-e', hostileServer],
        options as SpawnOptions,
      )) as typeof spawn,
    });

    try {
      await client.start();
      const next = await client.notifications().next();

      expect(next.done).toBe(false);
      expect(next.value).toEqual({
        method: 'audit/approvalRejected',
        params: {
          code: -32601,
          message: 'Unsupported app-server request: item/commandExecution/requestApproval',
        },
      });
    } finally {
      await client.close();
    }
  });
});
