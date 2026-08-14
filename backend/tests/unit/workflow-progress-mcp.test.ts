import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkflowProgressServer } from '../../src/services/workflow-progress-mcp.js';

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('workflow progress MCP bridge', () => {
  it('reports stdio tool calls through the workspace event channel', async () => {
    const workspacePath = join(tmpdir(), `workflow-progress-${randomUUID()}`);
    workspaces.push(workspacePath);
    await mkdir(workspacePath, { recursive: true });
    const events: Array<Record<string, unknown>> = [];
    const bridge = await createWorkflowProgressServer(
      workspacePath,
      new Map([['task-1', 'Analyze evidence']]),
      event => events.push(event),
    );
    const client = new Client({ name: 'workflow-progress-test', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: bridge.config.command!,
      args: bridge.config.args,
      env: bridge.config.env,
      cwd: workspacePath,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += String(chunk); });

    try {
      await client.connect(transport).catch(error => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr}`);
      });
      await client.callTool({
        name: 'workflow_step_complete',
        arguments: { taskId: 'task-1', summary: 'Evidence reviewed.' },
      });
      await bridge.drain();
    } finally {
      await client.close();
      await bridge.close();
    }

    expect(events).toEqual([{
      type: 'step_complete',
      taskId: 'task-1',
      taskTitle: 'Analyze evidence',
      message: 'Evidence reviewed.',
    }]);
  });
});
