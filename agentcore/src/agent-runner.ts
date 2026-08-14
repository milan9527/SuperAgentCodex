import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import {
  CodexAppServerClient,
  type CodexAppServerTransport,
} from './codex-app-server-client.js';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from './codex-event-adapter.js';
import type {
  AgentEvent,
  AgentPayload,
  MCPServerConfig,
  TokenUsage,
} from './types.js';
import { beginInvocation, parentContextFromHeaders } from './otel.js';

const WORKSPACE_DIR = '/workspace';
const CODEX_HOME = process.env.CODEX_HOME ?? '/home/node/.codex';
const RESPONSE_TIMEOUT_MS = Number(process.env.CODEX_RESPONSE_TIMEOUT_MS ?? 600_000);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_REQUEST_TIMEOUT_MS ?? 30_000);
const MAX_IMAGE_BYTES = Number(process.env.CODEX_MAX_IMAGE_BYTES ?? 20 * 1024 * 1024);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

interface ThreadResponse {
  thread: { id: string };
  model?: string;
}

interface TurnResponse {
  turn: { id: string };
}

interface ModelListResponse {
  data: Array<{ id?: string; model?: string; inputModalities?: string[] }>;
}

export type CodexClientFactory = () => CodexAppServerTransport;

export async function* runAgent(
  payload: AgentPayload,
  requestHeaders?: Record<string, unknown>,
  clientFactory: CodexClientFactory = createDefaultClient,
): AsyncGenerator<AgentEvent> {
  const client = clientFactory();
  const trace = beginInvocation(
    payload.chat_session_id ?? payload.provider_thread_id ?? payload.session_id ?? 'unknown-session',
    payload.prompt,
    parentContextFromHeaders(requestHeaders),
  );
  let finalAnswer = '';
  let finalModel = payload.model;
  let finalUsage: TokenUsage | undefined;
  let finalTurns: number | undefined;
  let failed = false;

  try {
    await client.start();
    const threadParams = buildThreadParams(payload);
    const requestedThreadId = payload.provider_thread_id ?? payload.session_id;
    let replayHistory = false;
    let threadResponse: ThreadResponse;

    if (requestedThreadId) {
      try {
        threadResponse = await client.request<ThreadResponse>('thread/resume', {
          threadId: requestedThreadId,
          ...threadParams,
          excludeTurns: true,
        });
      } catch (error) {
        console.warn(
          `[agent-runner] Failed to resume Codex thread ${requestedThreadId}; starting a new thread:`,
          error instanceof Error ? error.message : error,
        );
        threadResponse = await client.request<ThreadResponse>('thread/start', threadParams);
        replayHistory = Boolean(payload.history?.length);
      }
    } else {
      threadResponse = await client.request<ThreadResponse>('thread/start', threadParams);
    }

    const threadId = threadResponse.thread.id;
    finalModel = threadResponse.model ?? payload.model;
    yield {
      type: 'session_start',
      provider: 'codex',
      session_id: threadId,
      provider_thread_id: threadId,
      status: 'in_progress',
      model: finalModel,
    };

    const input = await buildTurnInput(
      client,
      payload,
      replayHistory ? payload.history : undefined,
    );
    const turnResponse = await client.request<TurnResponse>('turn/start', {
      threadId,
      input,
      cwd: WORKSPACE_DIR,
      runtimeWorkspaceRoots: [WORKSPACE_DIR],
      approvalPolicy: 'never',
      model: payload.model,
      effort: payload.reasoning_effort ?? 'high',
    });

    const state = createCodexAdapterState(
      threadId,
      finalModel,
      payload.requested_agent_name,
    );
    state.turnId = turnResponse.turn.id;
    const notifications = client.notifications();
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS;

    while (!state.terminal) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Codex response timed out');
      const next = await nextWithTimeout(notifications, remaining);
      if (next.done) throw new Error('Codex app-server closed before turn completion');
      for (const event of adaptCodexNotification(next.value, state)) {
        observeForTelemetry(event, trace);
        if (event.type === 'assistant') {
          finalAnswer += event.content
            ?.filter(block => block.type === 'text')
            .map(block => block.text)
            .join('') ?? '';
        }
        if (event.type === 'result' || event.type === 'error') {
          finalUsage = event.token_usage;
          finalTurns = event.num_turns;
          failed = event.type === 'error' || event.status === 'failed';
        }
        yield event;
      }
    }
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    finalAnswer ||= `error: ${message}`;
    yield {
      type: 'error',
      provider: 'codex',
      status: 'failed',
      code: classifyCodexError(error),
      message,
    };
  } finally {
    await client.close().catch(() => {});
    trace.end(finalAnswer, {
      isError: failed,
      model: finalModel,
      numTurns: finalTurns,
      tokenUsage: finalUsage,
    });
  }
}

function createDefaultClient(): CodexAppServerTransport {
  return new CodexAppServerClient({
    executablePath: process.env.CODEX_EXECUTABLE ?? 'codex',
    cwd: WORKSPACE_DIR,
    codexHome: CODEX_HOME,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function buildThreadParams(payload: AgentPayload): Record<string, unknown> {
  const params: Record<string, unknown> = {
    cwd: WORKSPACE_DIR,
    runtimeWorkspaceRoots: [WORKSPACE_DIR],
    approvalPolicy: 'never',
    // AgentCore already provides the isolation boundary. This preserves the
    // previous Claude runtime's bypass-permissions behavior inside that boundary.
    sandbox: 'danger-full-access',
    model: payload.model,
    modelProvider: payload.model_provider ?? 'amazon-bedrock',
    allowProviderModelFallback: false,
    serviceName: 'super-agent-agentcore',
    developerInstructions: payload.system_prompt ?? undefined,
  };
  const config: Record<string, unknown> = {
    model_providers: {
      'amazon-bedrock': {
        aws: {
          region: payload.aws_region
            ?? process.env.AWS_REGION
            ?? process.env.AWS_DEFAULT_REGION
            ?? 'us-east-1',
        },
      },
    },
  };
  const mcpServers = renderMcpServers(payload.mcp_servers);
  if (mcpServers) config.mcp_servers = mcpServers;
  params.config = config;
  return params;
}

async function buildTurnInput(
  client: CodexAppServerTransport,
  payload: AgentPayload,
  history: AgentPayload['history'],
): Promise<Array<Record<string, unknown>>> {
  const text = history?.length
    ? `${formatReplayHistory(history)}\n\nCurrent user request:\n${payload.prompt}`
    : payload.prompt;
  const input: Array<Record<string, unknown>> = [{
    type: 'text',
    text,
    text_elements: [],
  }];
  if (!payload.image_paths?.length) return input;

  await assertImageSupport(client, payload.model);
  for (const imagePath of payload.image_paths) {
    input.push({ type: 'localImage', path: resolveWorkspaceImage(imagePath) });
  }
  return input;
}

async function assertImageSupport(
  client: CodexAppServerTransport,
  model: string | undefined,
): Promise<void> {
  if (!model) throw new AgentRunnerError(
    'CODEX_MODEL_CAPABILITY_UNKNOWN',
    'Cannot validate image support without a resolved Codex model',
  );
  const models = await client.request<ModelListResponse>('model/list', {
    limit: 100,
    includeHidden: true,
  });
  const selected = models.data.find(item => item.id === model || item.model === model);
  if (!selected) throw new AgentRunnerError(
    'CODEX_MODEL_CAPABILITY_UNKNOWN',
    `Codex model capability metadata was not found for ${model}`,
  );
  if (selected.inputModalities && !selected.inputModalities.includes('image')) {
    throw new AgentRunnerError(
      'AGENT_IMAGE_UNSUPPORTED',
      `The selected Codex model does not accept image input: ${model}`,
    );
  }
}

function resolveWorkspaceImage(imagePath: string): string {
  if (!imagePath || isAbsolute(imagePath)) {
    throw new AgentRunnerError('AGENT_IMAGE_INVALID', 'Image paths must be workspace-relative');
  }
  let candidate: string;
  try {
    candidate = fs.realpathSync.native(resolve(WORKSPACE_DIR, imagePath));
  } catch {
    throw new AgentRunnerError('AGENT_IMAGE_NOT_FOUND', `Attached image was not found: ${imagePath}`);
  }
  const relativePath = relative(fs.realpathSync.native(WORKSPACE_DIR), candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new AgentRunnerError(
      'AGENT_IMAGE_FORBIDDEN',
      'Attached image escapes the session workspace',
    );
  }
  if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
    throw new AgentRunnerError('AGENT_IMAGE_INVALID', `Unsupported image type: ${imagePath}`);
  }
  const file = fs.statSync(candidate);
  if (!file.isFile() || file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
    throw new AgentRunnerError(
      'AGENT_IMAGE_INVALID',
      `Attached image must be non-empty and no larger than ${MAX_IMAGE_BYTES} bytes`,
    );
  }
  return candidate;
}

function renderMcpServers(
  servers: Record<string, MCPServerConfig> | undefined,
): Record<string, unknown> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  const rendered: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'sse') {
      throw new AgentRunnerError(
        'CODEX_MCP_TRANSPORT_UNSUPPORTED',
        `MCP server "${name}" uses legacy SSE transport; use HTTP or stdio`,
      );
    }
    if (server.type === 'stdio') {
      if (!server.command) {
        throw new AgentRunnerError('CODEX_MCP_INVALID', `MCP server "${name}" has no command`);
      }
      rendered[name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        required: true,
      };
    } else {
      if (!server.url) {
        throw new AgentRunnerError('CODEX_MCP_INVALID', `MCP server "${name}" has no URL`);
      }
      rendered[name] = {
        url: server.url,
        http_headers: server.headers ?? {},
        required: true,
      };
    }
  }
  return rendered;
}

function formatReplayHistory(
  history: NonNullable<AgentPayload['history']>,
): string {
  const maxChars = 32 * 1024;
  const lines = ['[Recovered conversation context after provider thread resume failed]'];
  let used = lines[0]!.length;
  for (const entry of history.slice(-24)) {
    const label = entry.role === 'user' ? 'User' : 'Assistant';
    const remaining = maxChars - used - label.length - 3;
    if (remaining <= 0) break;
    const content = entry.content.slice(0, remaining);
    lines.push(`${label}: ${content}`);
    used += label.length + content.length + 3;
  }
  lines.push('[End recovered context]');
  return lines.join('\n');
}

function observeForTelemetry(
  event: AgentEvent,
  trace: ReturnType<typeof beginInvocation>,
): void {
  if (event.type !== 'assistant') return;
  for (const block of event.content ?? []) {
    if (block.type === 'tool_use') {
      trace.recordTool(block.name, block.input, '', block.id);
    } else if (block.type === 'tool_result') {
      trace.recordToolResult(block.tool_use_id, block.content);
    }
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex response timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function classifyCodexError(error: unknown): string {
  if (error instanceof AgentRunnerError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('timed out')) return 'CODEX_TIMEOUT';
  if (message.includes('exited') || message.includes('closed')) return 'CODEX_PROCESS_EXITED';
  return 'CODEX_RUNTIME_ERROR';
}

class AgentRunnerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AgentRunnerError';
  }
}

export function createGitBaseline(): boolean {
  try {
    execSync('git init', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    execSync('git config user.email "agent@superagent.local"', {
      cwd: WORKSPACE_DIR,
      stdio: 'ignore',
    });
    execSync('git config user.name "Agent"', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    execSync('git add -A', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    execSync('git commit -m "baseline" --allow-empty', {
      cwd: WORKSPACE_DIR,
      stdio: 'ignore',
    });
    return true;
  } catch (error) {
    console.warn(
      '[git-diff] Failed to create baseline:',
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}
