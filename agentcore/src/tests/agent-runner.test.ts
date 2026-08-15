import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CodexAppServerTransport,
  CodexNotification,
} from '../codex-app-server-client.js';
import { renderMcpServers, runAgent } from '../agent-runner.js';
import type { AgentEvent } from '../types.js';

class FakeTransport implements CodexAppServerTransport {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  closed = false;

  constructor(
    private readonly events: CodexNotification[],
    private readonly resumeFails = false,
    private readonly modelList: Array<{
      id?: string;
      model?: string;
      inputModalities?: string[];
    }> = [{
      id: 'gpt-5.4',
      model: 'gpt-5.4',
      inputModalities: ['text', 'image'],
    }],
  ) {}

  async start(): Promise<void> {}

  async request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/resume' && this.resumeFails) {
      throw new Error('thread not found');
    }
    if (method === 'thread/resume' || method === 'thread/start') {
      return { thread: { id: 'thread-new' }, model: 'openai.gpt-5.4' } as T;
    }
    if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
    if (method === 'model/list') return { data: this.modelList } as T;
    throw new Error(`Unexpected request: ${method}`);
  }

  notify(): void {}

  async *notifications(): AsyncGenerator<CodexNotification> {
    for (const event of this.events) yield event;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class WaitingTransport extends FakeTransport {
  private resolveNotification?: (value: IteratorResult<CodexNotification>) => void;

  constructor() {
    super([]);
  }

  override async *notifications(): AsyncGenerator<CodexNotification> {
    const next = await new Promise<IteratorResult<CodexNotification>>(resolve => {
      this.resolveNotification = resolve;
    });
    if (!next.done) yield next.value;
  }

  override async close(): Promise<void> {
    this.resolveNotification?.({ value: undefined, done: true });
    await super.close();
  }
}

test('falls back to a new Codex thread and replays bounded history', async () => {
  const transport = new FakeTransport([
    {
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread-new', turnId: 'turn-1', itemId: 'msg-1', delta: 'done' },
    },
    {
      method: 'turn/completed',
      params: { threadId: 'thread-new', turnId: 'turn-1', turn: {
        id: 'turn-1',
        status: 'completed',
      }},
    },
  ], true);

  const events: AgentEvent[] = [];
  for await (const event of runAgent({
    prompt: 'continue',
    provider_thread_id: 'thread-missing',
    model: 'openai.gpt-5.4',
    history: [{ role: 'user', content: 'earlier request' }],
  }, undefined, () => transport)) {
    events.push(event);
  }

  assert.deepEqual(transport.calls.map(call => call.method), [
    'thread/resume',
    'thread/start',
    'turn/start',
  ]);
  const threadParams = transport.calls[1]!.params as {
    sandbox: string;
    runtimeWorkspaceRoots: string[];
  };
  assert.equal(threadParams.sandbox, 'workspace-write');
  assert.deepEqual(threadParams.runtimeWorkspaceRoots, ['/workspace']);
  const turnParams = transport.calls[2]!.params as {
    input: Array<{ type: string; text: string }>;
  };
  assert.match(turnParams.input[0]!.text, /Recovered conversation context/);
  assert.match(turnParams.input[0]!.text, /earlier request/);
  assert.equal(events[0]?.type, 'session_start');
  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(transport.closed, true);
});

test('resumes an existing thread without replaying platform history', async () => {
  const transport = new FakeTransport([{
    method: 'turn/completed',
    params: { threadId: 'thread-new', turnId: 'turn-1', turn: {
      id: 'turn-1',
      status: 'completed',
    }},
  }]);

  for await (const _event of runAgent({
    prompt: 'current',
    provider_thread_id: 'thread-existing',
    model: 'openai.gpt-5.4',
    history: [{ role: 'user', content: 'must not be replayed' }],
  }, undefined, () => transport)) {
    // consume
  }

  const turnParams = transport.calls[1]!.params as {
    input: Array<{ type: string; text: string }>;
  };
  assert.equal(turnParams.input[0]!.text, 'current');
});

test('interrupts the active Codex turn when the invocation is aborted', async () => {
  const transport = new WaitingTransport();
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const consume = (async () => {
    for await (const event of runAgent({
      prompt: 'wait',
      model: 'openai.gpt-5.4',
    }, undefined, () => transport, { signal: controller.signal })) {
      events.push(event);
      if (event.type === 'session_start') controller.abort();
    }
  })();

  await consume;

  assert.equal(events.at(-1)?.type, 'result');
  assert.equal(events.at(-1)?.status, 'interrupted');
  assert.deepEqual(transport.calls.at(-1), {
    method: 'turn/interrupt',
    params: { threadId: 'thread-new', turnId: 'turn-1' },
  });
  assert.equal(transport.closed, true);
});

test('accepts provider-qualified image models advertised without the provider prefix', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-image-'));
  await writeFile(join(workspace, 'evidence.png'), Buffer.from([137, 80, 78, 71]));
  const transport = new FakeTransport([{
    method: 'turn/completed',
    params: {
      threadId: 'thread-new',
      turnId: 'turn-1',
      turn: { id: 'turn-1', status: 'completed' },
    },
  }]);

  try {
    for await (const _event of runAgent({
      prompt: 'inspect',
      model: 'openai.gpt-5.4',
      image_paths: ['evidence.png'],
    }, undefined, () => transport, { workspaceDir: workspace })) {
      // consume
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  assert.deepEqual(transport.calls.map(call => call.method), [
    'thread/start',
    'model/list',
    'turn/start',
  ]);
  const turn = transport.calls[2]!.params as {
    input: Array<{ type: string; path?: string }>;
  };
  assert.deepEqual(turn.input[1], {
    type: 'localImage',
    path: join(workspace, 'evidence.png'),
  });
});

test('rejects a catalog model explicitly marked as text-only', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agentcore-image-'));
  await writeFile(join(workspace, 'evidence.png'), Buffer.from([137, 80, 78, 71]));
  const transport = new FakeTransport([], false, [{
    id: 'gpt-5.4',
    model: 'gpt-5.4',
    inputModalities: ['text'],
  }]);
  const events: AgentEvent[] = [];

  try {
    for await (const event of runAgent({
      prompt: 'inspect',
      model: 'openai.gpt-5.4',
      image_paths: ['evidence.png'],
    }, undefined, () => transport, { workspaceDir: workspace })) {
      events.push(event);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }

  assert.equal(events.at(-1)?.type, 'error');
  assert.equal(events.at(-1)?.code, 'AGENT_IMAGE_UNSUPPORTED');
  assert.equal(transport.calls.some(call => call.method === 'turn/start'), false);
});

test('rewrites the platform workflow progress MCP to container paths', () => {
  const rendered = renderMcpServers({
    'workflow-progress': {
      type: 'stdio',
      command: '/host/node',
      args: ['/host/backend/runtime-assets/workflow-progress-server.mjs'],
      env: {
        WORKFLOW_PROGRESS_EVENT_FILE: '/host/workspace/.runtime/workflow-progress/event.jsonl',
        WORKFLOW_PROGRESS_TITLES_B64: 'e30=',
      },
    },
  }, '/workspace') as Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
    default_tools_approval_mode: string;
  }>;

  assert.equal(rendered['workflow-progress']?.command, process.execPath);
  assert.deepEqual(rendered['workflow-progress']?.args, [
    '/app/runtime-assets/workflow-progress-server.mjs',
  ]);
  assert.equal(
    rendered['workflow-progress']?.env.WORKFLOW_PROGRESS_EVENT_FILE,
    '/workspace/.runtime/workflow-progress/event.jsonl',
  );
  assert.equal(
    rendered['workflow-progress']?.default_tools_approval_mode,
    'approve',
  );
});

test('rewrites AgentCore tools through the dedicated-resource policy proxy', () => {
  const rendered = renderMcpServers({
    'agentcore-tools': {
      type: 'stdio',
      command: 'uvx',
      args: ['awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2'],
      env: {
        AWS_REGION: 'us-east-1',
        BROWSER_IDENTIFIER: 'SuperAgentCodex_browser_webauth-fE2H1Jk9Cb',
        CODE_INTERPRETER_IDENTIFIER: 'SuperAgentCodex_code_interpreter-H5bXUddPM2',
      },
    },
  }) as Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
    default_tools_approval_mode: string;
  }>;

  assert.equal(rendered['agentcore-tools']?.command, process.execPath);
  assert.deepEqual(rendered['agentcore-tools']?.args, [
    '/app/runtime-assets/agentcore-tools-proxy.mjs',
  ]);
  assert.equal(
    rendered['agentcore-tools']?.env.BROWSER_IDENTIFIER,
    'SuperAgentCodex_browser_webauth-fE2H1Jk9Cb',
  );
  assert.equal(
    rendered['agentcore-tools']?.default_tools_approval_mode,
    'approve',
  );
});

test('rejects shared AgentCore tool identifiers', () => {
  assert.throws(() => renderMcpServers({
    'agentcore-tools': {
      type: 'stdio',
      command: 'uvx',
      env: {
        BROWSER_IDENTIFIER: 'aws.browser.v1',
        CODE_INTERPRETER_IDENTIFIER: 'aws.codeinterpreter.v1',
      },
    },
  }), /must reference a dedicated AgentCore resource/);
});

test('does not rewrite tenant-defined stdio MCP commands', () => {
  const rendered = renderMcpServers({
    tenant: {
      type: 'stdio',
      command: '/opt/tenant/server',
      args: ['--stdio'],
      env: { TENANT: '1' },
    },
  }) as Record<string, {
    command: string;
    args: string[];
    env: Record<string, string>;
    default_tools_approval_mode?: string;
  }>;

  assert.equal(rendered.tenant?.command, '/opt/tenant/server');
  assert.deepEqual(rendered.tenant?.args, ['--stdio']);
  assert.deepEqual(rendered.tenant?.env, { TENANT: '1' });
  assert.equal(rendered.tenant?.default_tools_approval_mode, undefined);
});
