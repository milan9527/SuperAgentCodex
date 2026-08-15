import { basename, extname } from 'node:path';
import type { AgentEvent, ContentBlock, TokenUsage } from './types.js';
import type { CodexNotification } from './codex-app-server-client.js';

interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string } | null;
  namespace?: string | null;
  contentItems?: unknown;
  success?: boolean | null;
  prompt?: string | null;
  model?: string | null;
  receiverThreadIds?: string[];
  agentThreadId?: string;
  agentPath?: string;
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  kind?: string;
}

export interface CodexAdapterState {
  threadId: string;
  turnId?: string;
  model?: string;
  emittedText: Map<string, string>;
  startedTools: Set<string>;
  usage?: TokenUsage;
  terminal: boolean;
  requestedAgentName?: string;
  subAgentNamesByThread: Map<string, string>;
  activeSubAgentToolIds: Map<string, string>;
}

export function createCodexAdapterState(
  threadId: string,
  model?: string,
  requestedAgentName?: string,
): CodexAdapterState {
  return {
    threadId,
    model,
    emittedText: new Map(),
    startedTools: new Set(),
    terminal: false,
    requestedAgentName,
    subAgentNamesByThread: new Map(),
    activeSubAgentToolIds: new Map(),
  };
}

export function adaptCodexNotification(
  notification: CodexNotification,
  state: CodexAdapterState,
): AgentEvent[] {
  if (!isRecord(notification.params)) return [];
  const params = notification.params;
  if (typeof params.threadId === 'string' && params.threadId !== state.threadId) return [];
  if (typeof params.turnId === 'string' && state.turnId && params.turnId !== state.turnId) return [];
  if (state.terminal) return [];

  switch (notification.method) {
    case 'turn/started': {
      const turn = asRecord(params.turn);
      if (typeof turn?.id === 'string') state.turnId = turn.id;
      return [];
    }
    case 'item/agentMessage/delta': {
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (!itemId || !delta) return [];
      state.emittedText.set(itemId, `${state.emittedText.get(itemId) ?? ''}${delta}`);
      return [assistantEvent(state, [{ type: 'text', text: delta }])];
    }
    case 'item/started': {
      const item = asItem(params.item);
      return item ? adaptItemStarted(item, state) : [];
    }
    case 'item/completed': {
      const item = asItem(params.item);
      return item ? adaptItemCompleted(item, state) : [];
    }
    case 'thread/tokenUsage/updated': {
      const usage = asRecord(asRecord(params.tokenUsage)?.last);
      if (usage) {
        state.usage = {
          input_tokens: numberOrZero(usage.inputTokens),
          output_tokens: numberOrZero(usage.outputTokens),
          cache_read_input_tokens: numberOrZero(usage.cachedInputTokens),
          cache_creation_input_tokens: numberOrZero(usage.cacheWriteInputTokens),
        };
      }
      return [];
    }
    case 'turn/diff/updated':
      return typeof params.diff === 'string'
        ? [baseEvent(state, { type: 'heartbeat', diff: params.diff })]
        : [];
    case 'turn/plan/updated': {
      const plan = Array.isArray(params.plan)
        ? params.plan.flatMap(entry => {
            const item = asRecord(entry);
            return item && typeof item.step === 'string' && typeof item.status === 'string'
              ? [{ step: item.step, status: item.status }]
              : [];
          })
        : [];
      return plan.length ? [baseEvent(state, { type: 'heartbeat', plan })] : [];
    }
    case 'turn/completed':
      return adaptTurnCompleted(params, state);
    case 'error': {
      if (params.willRetry === true) return [];
      state.terminal = true;
      const error = asRecord(params.error) ?? params;
      return [baseEvent(state, {
        type: 'error',
        status: 'failed',
        code: 'CODEX_APP_SERVER_ERROR',
        message: safeMessage(error.message, 'Codex app-server reported an error'),
      })];
    }
    default:
      return [];
  }
}

function adaptItemStarted(item: CodexThreadItem, state: CodexAdapterState): AgentEvent[] {
  if (item.type === 'subAgentActivity') return adaptSubAgentActivity(item, state);
  const block = toolUseBlock(item, state);
  if (!block || !item.id || state.startedTools.has(item.id)) return [];
  state.startedTools.add(item.id);
  return [assistantEvent(state, [block])];
}

function adaptItemCompleted(item: CodexThreadItem, state: CodexAdapterState): AgentEvent[] {
  if (item.type === 'subAgentActivity') return adaptSubAgentActivity(item, state);
  if (item.type === 'agentMessage' && item.id && typeof item.text === 'string') {
    const emitted = state.emittedText.get(item.id) ?? '';
    if (!emitted) return [assistantEvent(state, [{ type: 'text', text: item.text }])];
    if (item.text.startsWith(emitted) && item.text.length > emitted.length) {
      return [assistantEvent(state, [{ type: 'text', text: item.text.slice(emitted.length) }])];
    }
    return [];
  }

  const result = toolResultBlock(item);
  if (!result) return [];
  const events: AgentEvent[] = [];
  if (item.id && !state.startedTools.has(item.id)) {
    const start = toolUseBlock(item, state);
    if (start) events.push(assistantEvent(state, [start]));
  }
  events.push(assistantEvent(state, [result]));
  if (item.type === 'collabAgentToolCall') {
    events.push(...completeTerminalSubAgents(item, state));
  }
  return events;
}

function adaptTurnCompleted(
  params: Record<string, unknown>,
  state: CodexAdapterState,
): AgentEvent[] {
  const turn = asRecord(params.turn);
  const status = turn?.status;
  if (typeof turn?.id === 'string') state.turnId = turn.id;
  state.terminal = true;
  const durationMs = typeof turn?.durationMs === 'number' ? turn.durationMs : undefined;
  const closing = closeAllSubAgents(state, status === 'interrupted');

  if (status === 'failed') {
    return [...closing, baseEvent(state, {
      type: 'error',
      status: 'failed',
      code: 'CODEX_TURN_FAILED',
      message: safeMessage(asRecord(turn?.error)?.message, 'Codex turn failed'),
      duration_ms: durationMs,
      token_usage: state.usage,
    })];
  }

  return [...closing, baseEvent(state, {
    type: 'result',
    status: status === 'interrupted' ? 'interrupted' : 'completed',
    model: state.model,
    duration_ms: durationMs,
    num_turns: 1,
    token_usage: state.usage,
  })];
}

function toolUseBlock(
  item: CodexThreadItem,
  state: CodexAdapterState,
): Extract<ContentBlock, { type: 'tool_use' }> | null {
  if (!item.id) return null;
  switch (item.type) {
    case 'commandExecution':
      return { type: 'tool_use', id: item.id, name: 'Bash', input: {
        command: item.command ?? '',
        cwd: item.cwd ?? '',
      }};
    case 'fileChange':
      return { type: 'tool_use', id: item.id, name: 'Edit', input: {
        changes: item.changes ?? [],
      }};
    case 'mcpToolCall':
      return { type: 'tool_use', id: item.id, name:
        `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`,
        input: recordOrValue(item.arguments),
      };
    case 'dynamicToolCall':
      return { type: 'tool_use', id: item.id, name:
        item.namespace ? `${item.namespace}__${item.tool ?? 'unknown'}` : item.tool ?? 'unknown',
        input: recordOrValue(item.arguments),
      };
    case 'collabAgentToolCall': {
      const name = resolveCollabAgentName(item, state);
      return { type: 'tool_use', id: item.id, name: 'Task', input: {
        subagent_type: name,
        agent: name,
        tool: item.tool ?? 'spawnAgent',
        prompt: item.prompt ?? '',
        model: item.model ?? undefined,
        receiverThreadIds: item.receiverThreadIds ?? [],
      }};
    }
    default:
      return null;
  }
}

function toolResultBlock(
  item: CodexThreadItem,
): Extract<ContentBlock, { type: 'tool_result' }> | null {
  if (!item.id) return null;
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: item.aggregatedOutput ?? '',
        is_error: item.status === 'failed' || item.status === 'declined'
          || (item.exitCode ?? 0) !== 0,
      };
    case 'fileChange':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: stringifySafe(item.changes ?? []),
        is_error: item.status === 'failed' || item.status === 'declined',
      };
    case 'mcpToolCall':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: item.error?.message ?? stringifySafe(item.result),
        is_error: item.status === 'failed' || Boolean(item.error),
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: stringifySafe(item.contentItems),
        is_error: item.success === false || item.status === 'failed',
      };
    case 'collabAgentToolCall':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: stringifySafe({
          status: item.status,
          receiverThreadIds: item.receiverThreadIds ?? [],
        }),
        is_error: item.status === 'failed' || item.status === 'declined',
      };
    default:
      return null;
  }
}

function adaptSubAgentActivity(
  item: CodexThreadItem,
  state: CodexAdapterState,
): AgentEvent[] {
  if (!item.agentThreadId) return [];
  const name = technicalAgentName(item.agentPath) ?? state.requestedAgentName;
  if (name) state.subAgentNamesByThread.set(item.agentThreadId, name);
  if (item.kind === 'interrupted') {
    const toolId = state.activeSubAgentToolIds.get(item.agentThreadId);
    if (!toolId) return [];
    state.activeSubAgentToolIds.delete(item.agentThreadId);
    return [assistantEvent(state, [{
      type: 'tool_result',
      tool_use_id: toolId,
      content: 'Subagent interrupted',
      is_error: true,
    }])];
  }
  if (state.activeSubAgentToolIds.has(item.agentThreadId)) return [];
  const toolId = `codex-subagent:${item.agentThreadId}`;
  state.activeSubAgentToolIds.set(item.agentThreadId, toolId);
  return [assistantEvent(state, [{
    type: 'tool_use',
    id: toolId,
    name: 'Task',
    input: {
      subagent_type: name,
      agent: name,
      agentThreadId: item.agentThreadId,
      activity: item.kind ?? 'started',
    },
  }])];
}

function completeTerminalSubAgents(
  item: CodexThreadItem,
  state: CodexAdapterState,
): AgentEvent[] {
  const terminal = new Set(['completed', 'interrupted', 'errored', 'shutdown', 'notFound']);
  const events: AgentEvent[] = [];
  for (const [threadId, agentState] of Object.entries(item.agentsStates ?? {})) {
    if (!terminal.has(agentState.status ?? '')) continue;
    const toolId = state.activeSubAgentToolIds.get(threadId);
    if (!toolId) continue;
    state.activeSubAgentToolIds.delete(threadId);
    events.push(assistantEvent(state, [{
      type: 'tool_result',
      tool_use_id: toolId,
      content: agentState.message ?? agentState.status ?? 'Subagent completed',
      is_error: agentState.status === 'errored' || agentState.status === 'notFound',
    }]));
  }
  return events;
}

function closeAllSubAgents(state: CodexAdapterState, interrupted: boolean): AgentEvent[] {
  const events = [...state.activeSubAgentToolIds.values()].map(toolId => assistantEvent(state, [{
    type: 'tool_result' as const,
    tool_use_id: toolId,
    content: interrupted ? 'Parent turn interrupted' : 'Parent turn completed',
    is_error: interrupted,
  }]));
  state.activeSubAgentToolIds.clear();
  return events;
}

function assistantEvent(state: CodexAdapterState, content: ContentBlock[]): AgentEvent {
  return baseEvent(state, {
    type: 'assistant',
    status: 'in_progress',
    model: state.model,
    content,
  });
}

function baseEvent(
  state: CodexAdapterState,
  event: Omit<AgentEvent, 'provider' | 'session_id' | 'provider_thread_id' | 'provider_turn_id'>,
): AgentEvent {
  return {
    ...event,
    provider: 'codex',
    session_id: state.threadId,
    provider_thread_id: state.threadId,
    provider_turn_id: state.turnId,
  };
}

function resolveCollabAgentName(
  item: CodexThreadItem,
  state: CodexAdapterState,
): string | undefined {
  for (const threadId of item.receiverThreadIds ?? []) {
    const mapped = state.subAgentNamesByThread.get(threadId);
    if (mapped) return mapped;
  }
  return state.requestedAgentName;
}

function technicalAgentName(agentPath: string | undefined): string | undefined {
  if (!agentPath) return undefined;
  const file = basename(agentPath);
  const extension = extname(file);
  return extension ? file.slice(0, -extension.length) : file;
}

function asItem(value: unknown): CodexThreadItem | null {
  const item = asRecord(value);
  return item && typeof item.type === 'string' ? item as unknown as CodexThreadItem : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordOrValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : { value: value ?? null };
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function stringifySafe(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable result]';
  }
}

function safeMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}
