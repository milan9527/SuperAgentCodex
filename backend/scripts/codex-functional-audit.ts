import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import {
  CodexAppServerClient,
  type CodexNotification,
} from '../src/services/codex/codex-app-server-client.js';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from '../src/services/codex/codex-event-adapter.js';
import type { ConversationEvent } from '../src/services/agent-types.js';

const model = process.env.CODEX_E2E_MODEL ?? 'openai.gpt-5.4';
const modelProvider = process.env.CODEX_E2E_MODEL_PROVIDER ?? 'amazon-bedrock';
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 240_000);
const workspace = await mkdtemp(join(tmpdir(), 'codex-functional-workspace-'));
const codexHome = await mkdtemp(join(tmpdir(), 'codex-functional-home-'));
const progressFile = join(workspace, '.runtime', 'audit-progress.jsonl');
const progressServer = resolve('runtime-assets/workflow-progress-server.mjs');
const visionToken = 'VISION_7429';

try {
  await writeFile(join(workspace, 'AGENTS.md'), [
    '# Codex Functional Audit',
    '',
    'Follow each audit request exactly and keep final responses concise.',
    '',
  ].join('\n'));
  await writeFile(progressFile, '', { flag: 'w' }).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(workspace, '.runtime'), { recursive: true });
    await writeFile(progressFile, '');
  });
  await sharp(Buffer.from([
    '<svg width="800" height="260" xmlns="http://www.w3.org/2000/svg">',
    '<rect width="100%" height="100%" fill="white"/>',
    `<text x="50%" y="55%" text-anchor="middle" font-family="Arial" font-size="72" fill="black">${visionToken}</text>`,
    '</svg>',
  ].join(''))).png().toFile(join(workspace, 'vision-audit.png'));

  const firstClient = createClient();
  await firstClient.start();
  const thread = await firstClient.request<{ thread: { id: string }; model?: string }>(
    'thread/start',
    threadParams(),
  );
  const firstTurn = await runTurn(
    firstClient,
    thread.thread.id,
    [
      'Call the workflow-progress MCP tool workflow_step_complete exactly once with',
      'taskId "audit-task" and summary "MCP bridge verified.".',
      'Then reply with exactly LOCAL_MCP_OK.',
    ].join(' '),
    thread.model ?? model,
  );
  assertCompleted(firstTurn, 'LOCAL_MCP_OK');
  if (!firstTurn.events.some(event => event.type === 'assistant'
    && event.content?.some(block => block.type === 'tool_use'
      && block.name.includes('workflow_step_complete')))) {
    throw new Error('Codex did not emit the expected MCP tool lifecycle');
  }
  const progress = await readFile(progressFile, 'utf8');
  if (!progress.includes('"taskId":"audit-task"')
    || !progress.includes('"message":"MCP bridge verified."')) {
    throw new Error(
      `Workflow MCP bridge did not persist the expected event: ${progress}\n`
      + `Events: ${JSON.stringify(firstTurn.events, null, 2)}`,
    );
  }
  await firstClient.close();

  const resumedClient = createClient();
  await resumedClient.start();
  const resumed = await resumedClient.request<{ thread: { id: string }; model?: string }>(
    'thread/resume',
    {
      threadId: thread.thread.id,
      ...threadParams(),
      excludeTurns: true,
    },
  );
  if (resumed.thread.id !== thread.thread.id) {
    throw new Error(`Resume returned a different thread: ${resumed.thread.id}`);
  }
  const resumeTurn = await runTurn(
    resumedClient,
    resumed.thread.id,
    'Reply with exactly LOCAL_RESUME_OK. Do not use tools.',
    resumed.model ?? model,
  );
  assertCompleted(resumeTurn, 'LOCAL_RESUME_OK');

  const models = await resumedClient.request<{
    data: Array<{ id?: string; model?: string; inputModalities?: string[] }>;
  }>('model/list', { limit: 100, includeHidden: true });
  const catalogModel = model.startsWith('openai.') ? model.slice('openai.'.length) : model;
  const selected = models.data.find(entry => (
    entry.id === model
    || entry.model === model
    || entry.id === catalogModel
    || entry.model === catalogModel
  ));
  if (!selected) {
    throw new Error(`Model ${model} capability metadata was not found`);
  }
  if (!selected.inputModalities?.includes('image')) {
    throw new Error(`Model ${model} is not advertised as image-capable`);
  }
  const imageTurn = await runTurn(
    resumedClient,
    resumed.thread.id,
    'Read the exact token shown in the attached image and reply with only that token.',
    resumed.model ?? model,
    [{ type: 'localImage', path: join(workspace, 'vision-audit.png') }],
  );
  assertCompleted(imageTurn, visionToken);
  await resumedClient.close();

  console.log(JSON.stringify({
    ok: true,
    model,
    modelProvider,
    region,
    threadId: thread.thread.id,
    turns: {
      mcp: firstTurn.turnId,
      resume: resumeTurn.turnId,
      image: imageTurn.turnId,
    },
    assertions: [
      'stdio MCP tool lifecycle',
      'MCP side-effect file',
      'cross-process thread resume',
      'terminal-event uniqueness',
      'real localImage vision input',
    ],
  }, null, 2));
} finally {
  await Promise.all([
    rm(workspace, { recursive: true, force: true }),
    rm(codexHome, { recursive: true, force: true }),
  ]);
}

function createClient(): CodexAppServerClient {
  return new CodexAppServerClient({
    executablePath: process.env.CODEX_EXECUTABLE ?? 'codex',
    codexHome,
    cwd: workspace,
    requestTimeoutMs: 30_000,
  });
}

function threadParams(): Record<string, unknown> {
  return {
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: 'never',
    sandbox: 'workspace-write',
    model,
    modelProvider,
    allowProviderModelFallback: false,
    serviceName: 'super-agent-codex-functional-audit',
    ephemeral: false,
    config: {
      model_providers: {
        'amazon-bedrock': { aws: { region } },
      },
      mcp_servers: {
        'workflow-progress': {
          command: process.execPath,
          args: [progressServer],
          env: {
            WORKFLOW_PROGRESS_EVENT_FILE: progressFile,
            WORKFLOW_PROGRESS_TITLES_B64: Buffer.from(JSON.stringify({
              'audit-task': 'Codex MCP Audit',
            })).toString('base64'),
          },
          required: true,
          default_tools_approval_mode: 'approve',
        },
      },
    },
  };
}

async function runTurn(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
  effectiveModel: string,
  extraInput: Array<Record<string, unknown>> = [],
): Promise<{
  turnId: string;
  text: string;
  events: ConversationEvent[];
  terminalCount: number;
}> {
  const turn = await client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }, ...extraInput],
    cwd: workspace,
    runtimeWorkspaceRoots: [workspace],
    approvalPolicy: 'never',
    model,
    effort: 'low',
  });
  const state = createCodexAdapterState(threadId, effectiveModel);
  state.turnId = turn.turn.id;
  const events: ConversationEvent[] = [];
  let text = '';
  let terminalCount = 0;
  const iterator = client.notifications();
  const deadline = Date.now() + timeoutMs;

  while (!state.terminal) {
    const notification = await nextNotification(iterator, deadline);
    for (const event of adaptCodexNotification(notification, state)) {
      events.push(event);
      if (event.type === 'assistant') {
        text += event.content
          ?.filter(block => block.type === 'text')
          .map(block => block.text)
          .join('') ?? '';
      }
      if (event.type === 'result' || event.type === 'error') terminalCount++;
      if (event.type === 'error') {
        throw new Error(`${event.code ?? 'CODEX_ERROR'}: ${event.message ?? 'unknown error'}`);
      }
    }
  }
  await iterator.return(undefined);
  return { turnId: turn.turn.id, text: text.trim(), events, terminalCount };
}

async function nextNotification(
  iterator: AsyncGenerator<CodexNotification>,
  deadline: number,
): Promise<CodexNotification> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Codex functional audit timed out');
  let timer: NodeJS.Timeout | undefined;
  try {
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex functional audit timed out')), remaining);
      }),
    ]);
    if (next.done) throw new Error('Codex app-server closed before turn completion');
    return next.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertCompleted(
  result: { text: string; terminalCount: number },
  expectedText: string,
): void {
  if (result.terminalCount !== 1) {
    throw new Error(`Expected exactly one terminal event, got ${result.terminalCount}`);
  }
  if (!result.text.includes(expectedText)) {
    throw new Error(`Expected ${expectedText}, got ${JSON.stringify(result.text)}`);
  }
}
