import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

test('the stdio proxy constrains schemas and tool call identifiers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentcore-tools-proxy-'));
  const upstream = join(directory, 'fake-upstream.mjs');
  await writeFile(upstream, `
    import { createInterface } from 'node:readline';
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [{
              name: 'start_browser_session',
              inputSchema: {
                type: 'object',
                properties: { browser_identifier: { type: 'string' } },
              },
            }],
          },
        }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { received: message.params.arguments },
        }) + '\\n');
      }
    });
  `, 'utf-8');

  const proxy = spawn(
    process.execPath,
    [join(process.cwd(), 'runtime-assets', 'agentcore-tools-proxy.mjs')],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BROWSER_IDENTIFIER: 'dedicated-browser',
        CODE_INTERPRETER_IDENTIFIER: 'dedicated-code',
        AGENTCORE_TOOLS_UPSTREAM_COMMAND: process.execPath,
        AGENTCORE_TOOLS_UPSTREAM_ARGS_B64: Buffer.from(
          JSON.stringify([upstream]),
        ).toString('base64'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  const output = createInterface({ input: proxy.stdout, crlfDelay: Infinity });
  const responses: unknown[] = [];
  output.on('line', line => responses.push(JSON.parse(line)));

  try {
    proxy.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })}\n`);
    proxy.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'start_browser_session',
        arguments: { browser_identifier: 'aws.browser.v1' },
      },
    })}\n`);

    await waitFor(() => responses.length === 2);
    const toolsList = responses[0] as {
      result: {
        tools: Array<{
          inputSchema: {
            properties: {
              browser_identifier: Record<string, unknown>;
            };
          };
        }>;
      };
    };
    const toolCall = responses[1] as {
      result: { received: Record<string, unknown> };
    };
    assert.equal(
      toolsList.result.tools[0]?.inputSchema.properties.browser_identifier.const,
      'dedicated-browser',
    );
    assert.equal(toolCall.result.received.browser_identifier, 'dedicated-browser');
  } finally {
    proxy.stdin.end();
    proxy.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for proxy response');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
