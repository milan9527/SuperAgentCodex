import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { config } from '../config/index.js';
import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type {
  AgentConfig,
  ConversationEvent,
  MCPServerSDKConfig,
} from './agent-types.js';
import { workspaceManager, type SkillForWorkspace } from './workspace-manager.js';
import {
  CodexAppServerClient,
  type CodexAppServerTransport,
} from './codex/codex-app-server-client.js';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from './codex/codex-event-adapter.js';

interface ThreadResponse {
  thread: { id: string };
  model?: string;
}

interface TurnResponse {
  turn: { id: string };
}

interface ModelListResponse {
  data: Array<{
    id?: string;
    model?: string;
    inputModalities?: string[];
  }>;
}

interface ActiveTurn {
  platformSessionId: string;
  threadId: string;
  turnId?: string;
  client: CodexAppServerTransport;
  lastActivityAt: number;
  interrupted: boolean;
}

export type CodexClientFactory = (options: {
  cwd: string;
}) => CodexAppServerTransport;

export class CodexAgentRuntime implements AgentRuntime {
  readonly name = 'codex';
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly uniqueTurns = new Set<ActiveTurn>();
  private readonly clientFactory: CodexClientFactory;

  constructor(clientFactory?: CodexClientFactory) {
    this.clientFactory = clientFactory ?? (({ cwd }) => new CodexAppServerClient({
      executablePath: config.codex.executablePath,
      codexHome: config.codex.home,
      cwd,
      requestTimeoutMs: config.codex.requestTimeoutMs,
    }));
  }

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    _pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>,
  ): AsyncGenerator<ConversationEvent> {
    if (this.uniqueTurns.size >= config.codex.maxConcurrentSessions) {
      yield {
        type: 'error',
        provider: 'codex',
        status: 'failed',
        code: 'CODEX_CONCURRENCY_LIMIT',
        message: `Maximum concurrent Codex sessions reached (${config.codex.maxConcurrentSessions})`,
      };
      return;
    }

    const platformSessionId = options.sessionId ?? randomUUID();
    if (this.activeTurns.has(platformSessionId)) {
      yield {
        type: 'error',
        provider: 'codex',
        status: 'failed',
        code: 'CODEX_SESSION_BUSY',
        message: 'This session already has an active Codex turn',
      };
      return;
    }

    const workspacePath = options.workspacePath
      ?? await workspaceManager.ensureWorkspace(agentConfig.id, skills);
    const client = this.clientFactory({ cwd: workspacePath });
    let active: ActiveTurn | null = null;

    try {
      await client.start();
      const requestedThreadId = options.providerThreadId ?? options.providerSessionId;
      const threadParams = this.buildThreadParams(workspacePath, agentConfig, mcpServers);
      let replayedHistory = false;
      let threadResponse: ThreadResponse;
      if (requestedThreadId) {
        try {
          threadResponse = await client.request<ThreadResponse>('thread/resume', {
            threadId: requestedThreadId,
            ...threadParams,
            excludeTurns: true,
          });
        } catch {
          threadResponse = await client.request<ThreadResponse>('thread/start', threadParams);
          replayedHistory = Boolean(options.history?.length);
        }
      } else {
        threadResponse = await client.request<ThreadResponse>('thread/start', threadParams);
      }

      const threadId = threadResponse.thread.id;
      const model = threadResponse.model ?? this.resolveModel(agentConfig);
      active = {
        platformSessionId,
        threadId,
        client,
        lastActivityAt: Date.now(),
        interrupted: false,
      };
      this.trackActive(active);

      yield {
        type: 'session_start',
        provider: 'codex',
        sessionId: threadId,
        providerThreadId: threadId,
        status: 'in_progress',
        model,
      };

      const input = await this.buildTurnInput(
        client,
        workspacePath,
        model,
        replayedHistory ? options.history : undefined,
        options.message,
        options.imagePaths,
      );
      const turnResponse = await client.request<TurnResponse>('turn/start', {
        threadId,
        input,
        cwd: workspacePath,
        runtimeWorkspaceRoots: [workspacePath],
        approvalPolicy: 'never',
        model: this.resolveModel(agentConfig),
        effort: config.codex.reasoningEffort,
      });
      active.turnId = turnResponse.turn.id;
      active.lastActivityAt = Date.now();

      const state = createCodexAdapterState(threadId, model, options.requestedAgentName);
      state.turnId = turnResponse.turn.id;
      const deadline = Date.now() + config.codex.responseTimeoutMs;
      const notifications = client.notifications();

      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Codex response timed out');
        const next = await nextWithTimeout(notifications, remaining);
        if (next.done) throw new Error('Codex app-server closed before turn completion');
        active.lastActivityAt = Date.now();
        const events = adaptCodexNotification(next.value, state);
        for (const event of events) yield event;
        if (state.terminal) break;
      }
    } catch (error) {
      if (!active?.interrupted) {
        yield {
          type: 'error',
          provider: 'codex',
          providerThreadId: active?.threadId,
          providerTurnId: active?.turnId,
          status: 'failed',
          code: classifyCodexError(error),
          message: error instanceof Error ? error.message : String(error),
          suggestedAction: 'Check Codex authentication, model availability, and workspace permissions',
        };
      }
    } finally {
      if (active) this.untrackActive(active);
      await client.close().catch(() => {});
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const active = this.activeTurns.get(sessionId);
    if (!active || active.interrupted) return;
    active.interrupted = true;
    if (active.turnId) {
      await active.client.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }).catch(() => {});
    }
    await active.client.close().catch(() => {});
    this.untrackActive(active);
  }

  async disconnectAll(): Promise<number> {
    const active = [...this.uniqueTurns];
    await Promise.all(active.map(turn => this.disconnectSession(turn.platformSessionId)));
    return active.length;
  }

  get activeSessionCount(): number {
    return this.uniqueTurns.size;
  }

  hasSession(sessionId: string): boolean {
    return this.activeTurns.has(sessionId);
  }

  private buildThreadParams(
    workspacePath: string,
    agentConfig: AgentConfig,
    mcpServers?: Record<string, MCPServerSDKConfig>,
  ): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: workspacePath,
      runtimeWorkspaceRoots: [workspacePath],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: this.resolveModel(agentConfig),
      modelProvider: config.codex.modelProvider,
      allowProviderModelFallback: false,
      serviceName: 'super-agent-platform',
      developerInstructions: agentConfig.systemPrompt ?? undefined,
    };
    const threadConfig: Record<string, unknown> = {
      model_providers: {
        'amazon-bedrock': {
          aws: { region: config.aws.region },
        },
      },
    };
    const renderedMcpServers = renderMcpServers(mcpServers);
    if (renderedMcpServers) {
      threadConfig.mcp_servers = renderedMcpServers;
    }
    params.config = threadConfig;
    return params;
  }

  private resolveModel(agentConfig: AgentConfig): string | undefined {
    const candidates = [
      agentConfig.model,
      agentConfig.resolvedModel?.modelId,
      config.codex.model,
    ];
    return candidates.find(candidate => (
      typeof candidate === 'string'
      && (candidate.startsWith('openai.gpt-') || candidate.startsWith('gpt-'))
    ));
  }

  private async buildTurnInput(
    client: CodexAppServerTransport,
    workspacePath: string,
    model: string | undefined,
    history: AgentRuntimeOptions['history'],
    message: string,
    imagePaths: string[] | undefined,
  ): Promise<Array<Record<string, unknown>>> {
    const text = history?.length
      ? `${formatReplayHistory(history)}\n\nCurrent user request:\n${message}`
      : message;
    const input: Array<Record<string, unknown>> = [{
      type: 'text',
      text,
      text_elements: [],
    }];
    if (!imagePaths?.length) return input;

    await this.assertImageSupport(client, model);
    for (const imagePath of imagePaths) {
      input.push({
        type: 'localImage',
        path: await resolveWorkspaceImage(workspacePath, imagePath),
      });
    }
    return input;
  }

  private async assertImageSupport(
    client: CodexAppServerTransport,
    model: string | undefined,
  ): Promise<void> {
    if (!model) {
      throw new CodexRuntimeError(
        'CODEX_MODEL_CAPABILITY_UNKNOWN',
        'Cannot validate image support without a resolved Codex model',
      );
    }
    const models = await client.request<ModelListResponse>('model/list', {
      limit: 100,
      includeHidden: true,
    });
    const selected = models.data.find(entry => entry.id === model || entry.model === model);
    if (!selected) {
      throw new CodexRuntimeError(
        'CODEX_MODEL_CAPABILITY_UNKNOWN',
        `Codex model capability metadata was not found for ${model}`,
      );
    }
    if (selected.inputModalities && !selected.inputModalities.includes('image')) {
      throw new CodexRuntimeError(
        'AGENT_IMAGE_UNSUPPORTED',
        `The selected Codex model does not accept image input: ${model}`,
      );
    }
  }

  private trackActive(active: ActiveTurn): void {
    this.uniqueTurns.add(active);
    this.activeTurns.set(active.platformSessionId, active);
    this.activeTurns.set(active.threadId, active);
  }

  private untrackActive(active: ActiveTurn): void {
    this.uniqueTurns.delete(active);
    if (this.activeTurns.get(active.platformSessionId) === active) {
      this.activeTurns.delete(active.platformSessionId);
    }
    if (this.activeTurns.get(active.threadId) === active) {
      this.activeTurns.delete(active.threadId);
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
  if (error instanceof CodexRuntimeError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('thread/resume')) return 'CODEX_THREAD_RESUME_FAILED';
  if (message.includes('timed out')) return 'CODEX_TIMEOUT';
  if (message.includes('exited') || message.includes('closed')) return 'CODEX_PROCESS_EXITED';
  return 'CODEX_RUNTIME_ERROR';
}

class CodexRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRuntimeError';
  }
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

async function resolveWorkspaceImage(workspacePath: string, imagePath: string): Promise<string> {
  if (!imagePath || isAbsolute(imagePath)) {
    throw new CodexRuntimeError('AGENT_IMAGE_INVALID', 'Image paths must be workspace-relative');
  }
  const workspaceRoot = await realpath(workspacePath);
  const candidate = await realpath(resolve(workspaceRoot, imagePath)).catch(() => null);
  if (!candidate) {
    throw new CodexRuntimeError('AGENT_IMAGE_NOT_FOUND', `Attached image was not found: ${imagePath}`);
  }
  const relativePath = relative(workspaceRoot, candidate);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new CodexRuntimeError('AGENT_IMAGE_FORBIDDEN', 'Attached image escapes the session workspace');
  }
  if (!IMAGE_EXTENSIONS.has(extname(candidate).toLowerCase())) {
    throw new CodexRuntimeError('AGENT_IMAGE_INVALID', `Unsupported image type: ${imagePath}`);
  }
  const file = await stat(candidate);
  if (!file.isFile() || file.size <= 0 || file.size > config.codex.maxImageBytes) {
    throw new CodexRuntimeError(
      'AGENT_IMAGE_INVALID',
      `Attached image must be a non-empty file no larger than ${config.codex.maxImageBytes} bytes`,
    );
  }
  return candidate;
}

function formatReplayHistory(history: NonNullable<AgentRuntimeOptions['history']>): string {
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

function renderMcpServers(
  servers: Record<string, MCPServerSDKConfig> | undefined,
): Record<string, unknown> | undefined {
  if (!servers || Object.keys(servers).length === 0) return undefined;
  const rendered: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.type === 'sse') {
      throw new CodexRuntimeError(
        'CODEX_MCP_TRANSPORT_UNSUPPORTED',
        `MCP server "${name}" uses legacy SSE transport; configure streamable HTTP or stdio`,
      );
    }
    if (server.type === 'stdio') {
      if (!server.command) {
        throw new CodexRuntimeError('CODEX_MCP_INVALID', `MCP server "${name}" has no command`);
      }
      rendered[name] = {
        command: server.command,
        args: server.args ?? [],
        env: server.env ?? {},
        required: true,
      };
      continue;
    }
    if (!server.url) {
      throw new CodexRuntimeError('CODEX_MCP_INVALID', `MCP server "${name}" has no URL`);
    }
    rendered[name] = {
      url: server.url,
      http_headers: server.headers ?? {},
      required: true,
    };
  }
  return rendered;
}
