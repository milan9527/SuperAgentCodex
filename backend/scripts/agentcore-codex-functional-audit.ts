import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  content?: string;
  is_error?: boolean;
}

interface AgentCoreEvent {
  type?: string;
  status?: string;
  code?: string;
  message?: string;
  provider_thread_id?: string;
  provider_turn_id?: string;
  content?: ContentBlock[];
  workspace_sync?: {
    uploaded?: number;
    deleted?: number;
    diff_uploaded?: boolean;
  };
}

interface InvocationResult {
  events: AgentCoreEvent[];
  text: string;
  terminal?: AgentCoreEvent;
  providerThreadId?: string;
}

const runtimeArn = requiredEnv('AGENTCORE_RUNTIME_ARN');
const bucket = requiredEnv('AGENTCORE_WORKSPACE_S3_BUCKET');
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const workspaceRegion = process.env.WORKSPACE_S3_REGION ?? 'us-east-1';
const model = process.env.CODEX_E2E_MODEL ?? 'openai.gpt-5.4';
const runId = process.env.AGENTCORE_E2E_RUN_ID ?? randomUUID();
const agentCore = new BedrockAgentCoreClient({ region });
const s3 = new S3Client({ region: workspaceRegion });
const selectedScenarios = new Set(
  (process.env.AGENTCORE_AUDIT_SCENARIOS ?? 'image,sandbox,managed-mcp,cancellation')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
);

const results: Record<string, unknown> = {};

if (selectedScenarios.has('image')) {
  results.image = await auditImage();
  console.error('[agentcore-audit] image passed');
}
if (selectedScenarios.has('sandbox')) {
  results.sandbox = await auditSandbox();
  console.error('[agentcore-audit] sandbox passed');
}
if (selectedScenarios.has('managed-mcp')) {
  results.managedMcp = await auditManagedMcp();
  console.error('[agentcore-audit] managed MCP passed');
}
if (selectedScenarios.has('cancellation')) {
  results.cancellation = await auditCancellation();
  console.error('[agentcore-audit] cancellation passed');
}

console.log(JSON.stringify({
  ok: true,
  runtimeArn,
  region,
  workspaceRegion,
  model,
  runId,
  results,
}, null, 2));

async function auditImage(): Promise<Record<string, unknown>> {
  const scenario = await createScenario('image');
  const token = 'AGENTCORE_VISION_8642';
  const image = await sharp(Buffer.from([
    '<svg width="900" height="280" xmlns="http://www.w3.org/2000/svg">',
    '<rect width="100%" height="100%" fill="white"/>',
    `<text x="50%" y="55%" text-anchor="middle" font-family="Arial" font-size="72" fill="black">${token}</text>`,
    '</svg>',
  ].join(''))).png().toBuffer();
  await putObject(`${scenario.prefix}vision.png`, image, 'image/png');

  const invocation = await invoke(scenario, {
    prompt: 'Read the exact token in vision.png and reply with only that token.',
    image_paths: ['vision.png'],
  });
  assertCompleted(invocation, token);

  return {
    providerThreadId: invocation.providerThreadId,
    providerTurnId: invocation.terminal?.provider_turn_id,
    token,
  };
}

async function auditSandbox(): Promise<Record<string, unknown>> {
  const scenario = await createScenario('sandbox');
  const invocation = await invoke(scenario, {
    prompt: [
      'Use the shell to run this exact command:',
      '`if touch /home/node/codex-outside-audit 2>/dev/null; then echo outside-write-allowed; else echo outside-write-blocked; fi > sandbox-verdict.txt;',
      'if curl -fsS --max-time 5 https://example.com >/dev/null 2>&1; then echo network-allowed; else echo network-blocked; fi >> sandbox-verdict.txt`.',
      'Then read sandbox-verdict.txt and reply with exactly SANDBOX_AUDIT_OK.',
    ].join(' '),
  });
  assertCompleted(invocation, 'SANDBOX_AUDIT_OK');
  const verdict = (await getObject(`${scenario.prefix}sandbox-verdict.txt`)).trim();
  if (verdict !== 'outside-write-blocked\nnetwork-blocked') {
    throw new Error(`Sandbox policy was not enforced: ${JSON.stringify(verdict)}`);
  }

  return {
    providerThreadId: invocation.providerThreadId,
    providerTurnId: invocation.terminal?.provider_turn_id,
    verdict,
  };
}

async function auditManagedMcp(): Promise<Record<string, unknown>> {
  const scenario = await createScenario('managed-mcp');
  const invocation = await invoke(scenario, {
    prompt: [
      'Use the AgentCore code interpreter MCP tool to calculate 12345 * 6789.',
      'Use the AgentCore browser MCP tool to open https://example.com and read its page title.',
      'Do not calculate or guess without the tools.',
      'Reply with exactly CODE=83810205;TITLE=Example Domain.',
    ].join(' '),
    mcp_servers: {
      'agentcore-tools': {
        type: 'stdio',
        command: 'uvx',
        args: ['awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2'],
        env: {
          AWS_REGION: region,
          FASTMCP_LOG_LEVEL: 'ERROR',
          BROWSER_IDENTIFIER: process.env.AGENTCORE_BROWSER_IDENTIFIER
            ?? 'aws.browser.v1',
          CODE_INTERPRETER_IDENTIFIER: process.env.AGENTCORE_CODE_INTERPRETER_IDENTIFIER
            ?? 'aws.codeinterpreter.v1',
        },
      },
    },
  }, 360_000);
  assertCompleted(invocation, 'CODE=83810205;TITLE=Example Domain');
  const tools = invocation.events.flatMap(event => event.content ?? [])
    .filter(block => block.type === 'tool_use')
    .map(block => block.name ?? '');
  if (!tools.some(name => /code.*interpreter/i.test(name))) {
    throw new Error(`Code Interpreter MCP tool was not used: ${JSON.stringify(tools)}`);
  }
  if (!tools.some(name => /browser/i.test(name))) {
    throw new Error(`Browser MCP tool was not used: ${JSON.stringify(tools)}`);
  }

  return {
    providerThreadId: invocation.providerThreadId,
    providerTurnId: invocation.terminal?.provider_turn_id,
    tools,
  };
}

async function auditCancellation(): Promise<Record<string, unknown>> {
  const scenario = await createScenario('cancel');
  const controller = new AbortController();
  let interruptedThreadId: string | undefined;
  let aborted = false;
  let abortTimer: NodeJS.Timeout | undefined;

  try {
    const completed = await invoke(scenario, {
      prompt: 'Run the shell command `sleep 60`, then reply with CANCEL_SHOULD_NOT_COMPLETE.',
    }, 120_000, {
      signal: controller.signal,
      onEvent(event) {
        interruptedThreadId ??= event.provider_thread_id;
        if (event.type === 'session_start' && !abortTimer) {
          abortTimer = setTimeout(() => {
            aborted = true;
            controller.abort();
          }, 1_500);
        }
        const startedCommand = event.content?.some(block => (
          block.type === 'tool_use'
          && /command|shell|bash|exec/i.test(block.name ?? '')
        ));
        if (startedCommand && !controller.signal.aborted) {
          aborted = true;
          controller.abort();
        }
      },
    });
    throw new Error(
      `Cancellation audit unexpectedly completed: ${JSON.stringify(completed.events)}`,
    );
  } catch (error) {
    if (!aborted || !isAbortError(error)) throw error;
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }

  if (!interruptedThreadId) {
    throw new Error('Cancellation audit did not receive a provider thread id');
  }
  await new Promise(resolve => setTimeout(resolve, 4_000));

  const resumed = await invoke(scenario, {
    prompt: 'Reply with exactly CANCEL_RECOVERY_OK. Do not use tools.',
    provider_thread_id: interruptedThreadId,
  });
  assertCompleted(resumed, 'CANCEL_RECOVERY_OK');
  if (resumed.providerThreadId !== interruptedThreadId) {
    throw new Error(
      `Cancellation recovery started a different thread: ${resumed.providerThreadId}`,
    );
  }

  return {
    interruptedThreadId,
    recoveredTurnId: resumed.terminal?.provider_turn_id,
  };
}

async function createScenario(name: string): Promise<{
  prefix: string;
  sessionId: string;
}> {
  const suffix = `${runId}-${name}`;
  const prefix = `codex-audit/${suffix}/`;
  const sessionId = `codex-audit-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(33, '_');
  await putObject(`${prefix}AGENTS.md`, Buffer.from([
    '# Codex AgentCore Functional Audit',
    '',
    'Follow the user request exactly. Do not substitute simulated tool output.',
    '',
  ].join('\n')), 'text/markdown');
  return { prefix, sessionId };
}

async function invoke(
  scenario: { prefix: string; sessionId: string },
  overrides: Record<string, unknown>,
  timeoutMs = 240_000,
  options?: {
    signal?: AbortSignal;
    onEvent?(event: AgentCoreEvent): void;
  },
): Promise<InvocationResult> {
  const payload = {
    protocol_version: 2,
    runtime: 'codex',
    chat_session_id: scenario.sessionId,
    scope_id: 'codex-audit',
    org_id: 'codex-audit',
    agent_id: 'codex-audit',
    model,
    model_provider: 'amazon-bedrock',
    aws_region: region,
    reasoning_effort: 'high',
    workspace_s3_bucket: bucket,
    workspace_s3_prefix: scenario.prefix,
    ...overrides,
  };
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options?.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  const response = await agentCore.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    runtimeSessionId: scenario.sessionId,
    qualifier: 'DEFAULT',
    contentType: 'application/json',
    accept: 'text/event-stream',
    payload: Buffer.from(JSON.stringify(payload)),
  }), { abortSignal: signal });

  let buffer = '';
  let text = '';
  let terminal: AgentCoreEvent | undefined;
  let providerThreadId: string | undefined;
  const events: AgentCoreEvent[] = [];

  for await (const chunk of response.response) {
    buffer += Buffer.from(chunk).toString('utf8');
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      for (const line of frame.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as AgentCoreEvent;
        events.push(event);
        providerThreadId ??= event.provider_thread_id;
        options?.onEvent?.(event);
        if (event.type === 'assistant') {
          text += event.content
            ?.filter(block => block.type === 'text')
            .map(block => block.text ?? '')
            .join('') ?? '';
        }
        if (event.type === 'result' || event.type === 'error') terminal = event;
      }
    }
  }

  return { events, text: text.trim(), terminal, providerThreadId };
}

function assertCompleted(result: InvocationResult, expectedText: string): void {
  const terminals = result.events.filter(event => (
    event.type === 'result' || event.type === 'error'
  ));
  if (terminals.length !== 1) {
    throw new Error(`Expected one terminal event, got ${terminals.length}`);
  }
  if (result.terminal?.type !== 'result' || result.terminal.status !== 'completed') {
    throw new Error(`AgentCore audit did not complete: ${JSON.stringify(result.terminal)}`);
  }
  if (!result.text.endsWith(expectedText)) {
    throw new Error(`Expected ${expectedText}, got ${JSON.stringify(result.text)}`);
  }
  const syncIndex = result.events.findIndex(event => event.workspace_sync);
  const terminalIndex = result.events.indexOf(result.terminal);
  if (syncIndex < 0 || syncIndex >= terminalIndex) {
    throw new Error('Workspace sync was not confirmed before the terminal event');
  }
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
}

async function getObject(key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return (await response.Body?.transformToString()) ?? '';
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error
    && (error.name === 'AbortError' || /abort/i.test(error.message));
}
