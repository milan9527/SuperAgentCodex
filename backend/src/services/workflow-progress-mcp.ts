/**
 * Provider-neutral workflow progress MCP bridge.
 *
 * The MCP server runs over stdio and appends progress events to a workspace
 * JSONL file. This makes the configuration serializable for Codex and
 * AgentCore while preserving the executor's callback contract.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MCPServerSDKConfig } from './agent-types.js';
import type { WorkflowProgressEvent } from './workflow-executor-v2.js';

export type NodeTitleMap = Map<string, string>;
export type ProgressCallback = (event: WorkflowProgressEvent) => void;

export interface WorkflowProgressBridge {
  config: MCPServerSDKConfig;
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function createWorkflowProgressServer(
  workspacePath: string,
  nodeTitleMap: NodeTitleMap,
  onProgress: ProgressCallback,
): Promise<WorkflowProgressBridge> {
  const bridgeDir = join(workspacePath, '.runtime', 'workflow-progress');
  const eventFile = join(bridgeDir, `${randomUUID()}.jsonl`);
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(eventFile, '', 'utf-8');

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const backendRoot = resolve(moduleDir, '..', '..');
  const serverScript = join(backendRoot, 'runtime-assets', 'workflow-progress-server.mjs');
  const titles = Object.fromEntries(nodeTitleMap);
  let offset = 0;
  let remainder = '';

  const drain = async (): Promise<void> => {
    const data = await readFile(eventFile).catch(() => Buffer.alloc(0));
    if (data.length <= offset) return;
    const chunk = remainder + data.subarray(offset).toString('utf-8');
    offset = data.length;
    const lines = chunk.split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as WorkflowProgressEvent;
      onProgress(parsed);
    }
  };

  return {
    config: {
      type: 'stdio',
      command: process.execPath,
      args: [serverScript],
      env: {
        WORKFLOW_PROGRESS_EVENT_FILE: eventFile,
        WORKFLOW_PROGRESS_TITLES_B64: Buffer.from(JSON.stringify(titles), 'utf-8').toString('base64'),
      },
    },
    drain,
    close: async () => {
      await drain();
      await rm(eventFile, { force: true });
    },
  };
}
