import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const eventFile = process.env.WORKFLOW_PROGRESS_EVENT_FILE;
if (!eventFile) throw new Error('WORKFLOW_PROGRESS_EVENT_FILE is required');

const titles = JSON.parse(
  Buffer.from(process.env.WORKFLOW_PROGRESS_TITLES_B64 ?? 'e30=', 'base64').toString('utf-8'),
);
fs.mkdirSync(path.dirname(eventFile), { recursive: true });

const server = new McpServer({ name: 'workflow-progress', version: '2.0.0' });

server.registerTool(
  'workflow_step_start',
  {
    description: 'Signal that a workflow step is starting.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().describe('Task ID from the workflow execution plan'),
    },
  },
  async ({ taskId }) => {
    appendEvent({ type: 'step_start', taskId, taskTitle: titles[taskId] });
    return textResult(`Step "${titles[taskId] ?? taskId}" marked as started.`);
  },
);

server.registerTool(
  'workflow_step_complete',
  {
    description: 'Signal that a workflow step completed successfully.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().describe('Task ID from the workflow execution plan'),
      summary: z.string().optional().describe('Brief completion summary'),
    },
  },
  async ({ taskId, summary }) => {
    appendEvent({
      type: 'step_complete',
      taskId,
      taskTitle: titles[taskId],
      message: summary,
    });
    return textResult(`Step "${titles[taskId] ?? taskId}" marked as complete.`);
  },
);

server.registerTool(
  'workflow_step_failed',
  {
    description: 'Signal that a workflow step failed.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      taskId: z.string().describe('Task ID from the workflow execution plan'),
      reason: z.string().optional().describe('Failure reason'),
    },
  },
  async ({ taskId, reason }) => {
    appendEvent({
      type: 'step_failed',
      taskId,
      taskTitle: titles[taskId],
      message: reason,
    });
    return textResult(`Step "${titles[taskId] ?? taskId}" marked as failed.`);
  },
);

const transport = new StdioServerTransport();
process.stdin.resume();
await server.connect(transport);
process.stdin.once('end', () => {
  void server.close();
});

function appendEvent(event) {
  fs.appendFileSync(eventFile, `${JSON.stringify(event)}\n`, 'utf-8');
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}
