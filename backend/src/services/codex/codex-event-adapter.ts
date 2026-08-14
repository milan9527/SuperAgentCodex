import type { ContentBlock, ConversationEvent, TokenUsage } from '../agent-types.js';
import type { CodexNotification } from './codex-app-server-client.js';
import { basename, extname } from 'node:path';

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
  senderThreadId?: string;
  agentsStates?: Record<string, { status?: string; message?: string | null }>;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
}

interface AdapterState {
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
): AdapterState {
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
  state: AdapterState,
): ConversationEvent[] {
  if (!notification.params || typeof notification.params !== 'object') return [];
  const params = notification.params as Record<string, unknown>;
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
      const tokenUsage = asRecord(params.tokenUsage);
      const last = asRecord(tokenUsage?.last);
      if (last) {
        state.usage = {
          inputTokens: numberOrZero(last.inputTokens),
          outputTokens: numberOrZero(last.outputTokens),
          cacheReadInputTokens: numberOrZero(last.cachedInputTokens),
          cacheCreationInputTokens: numberOrZero(last.cacheWriteInputTokens),
          totalCostUsd: 0,
        };
      }
      return [];
    }
    case 'turn/diff/updated': {
      return typeof params.diff === 'string'
        ? [{
            type: 'heartbeat',
            provider: 'codex',
            providerThreadId: state.threadId,
            providerTurnId: state.turnId,
            diff: params.diff,
          }]
        : [];
    }
    case 'turn/plan/updated': {
      const plan = Array.isArray(params.plan)
        ? params.plan.flatMap(entry => {
            const value = asRecord(entry);
            return value && typeof value.step === 'string' && typeof value.status === 'string'
              ? [{ step: value.step, status: value.status }]
              : [];
          })
        : [];
      return plan.length > 0
        ? [{
            type: 'heartbeat',
            provider: 'codex',
            providerThreadId: state.threadId,
            providerTurnId: state.turnId,
            plan,
          }]
        : [];
    }
    case 'turn/completed':
      return adaptTurnCompleted(params, state);
    case 'error': {
      if (params.willRetry === true) return [];
      const error = asRecord(params.error) ?? params;
      state.terminal = true;
      return [{
        type: 'error',
        provider: 'codex',
        providerThreadId: state.threadId,
        providerTurnId: state.turnId,
        status: 'failed',
        code: 'CODEX_APP_SERVER_ERROR',
        message: safeMessage(error.message, 'Codex app-server reported an error'),
      }];
    }
    default:
      return [];
  }
}

function adaptItemStarted(item: CodexThreadItem, state: AdapterState): ConversationEvent[] {
  if (item.type === 'subAgentActivity') {
    return adaptSubAgentActivity(item, state);
  }
  const block = toolUseBlock(item, state);
  if (!block || !item.id || state.startedTools.has(item.id)) return [];
  state.startedTools.add(item.id);
  return [assistantEvent(state, [block])];
}

function adaptItemCompleted(item: CodexThreadItem, state: AdapterState): ConversationEvent[] {
  if (item.type === 'subAgentActivity') {
    return adaptSubAgentActivity(item, state);
  }
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
  const events: ConversationEvent[] = [];
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
  state: AdapterState,
): ConversationEvent[] {
  const turn = asRecord(params.turn);
  const status = turn?.status;
  const durationMs = typeof turn?.durationMs === 'number' ? turn.durationMs : undefined;
  if (typeof turn?.id === 'string') state.turnId = turn.id;
  state.terminal = true;

  const closingEvents = closeAllSubAgents(state, status === 'interrupted');

  if (status === 'failed') {
    const error = asRecord(turn?.error);
    return [...closingEvents, {
      type: 'error',
      provider: 'codex',
      providerThreadId: state.threadId,
      providerTurnId: state.turnId,
      status: 'failed',
      code: 'CODEX_TURN_FAILED',
      message: safeMessage(error?.message, 'Codex turn failed'),
      durationMs,
      tokenUsage: state.usage,
    }];
  }

  const normalizedStatus = status === 'interrupted' ? 'interrupted' : 'completed';
  return [...closingEvents, {
    type: 'result',
    provider: 'codex',
    providerThreadId: state.threadId,
    providerTurnId: state.turnId,
    status: normalizedStatus,
    model: state.model,
    durationMs,
    numTurns: 1,
    tokenUsage: state.usage,
  }];
}

function toolUseBlock(
  item: CodexThreadItem,
  state: AdapterState,
): Extract<ContentBlock, { type: 'tool_use' }> | null {
  if (!item.id) return null;
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'Bash',
        input: { command: item.command ?? '', cwd: item.cwd ?? '' },
        category: 'command',
      };
    case 'fileChange':
      return {
        type: 'tool_use',
        id: item.id,
        name: 'Edit',
        input: { changes: item.changes ?? [] },
        category: 'file',
      };
    case 'mcpToolCall':
      return {
        type: 'tool_use',
        id: item.id,
        name: `mcp__${item.server ?? 'unknown'}__${item.tool ?? 'unknown'}`,
        input: isRecord(item.arguments) ? item.arguments : { value: item.arguments ?? null },
        category: 'mcp',
      };
    case 'dynamicToolCall':
      return {
        type: 'tool_use',
        id: item.id,
        name: item.namespace ? `${item.namespace}__${item.tool ?? 'unknown'}` : (item.tool ?? 'unknown'),
        input: isRecord(item.arguments) ? item.arguments : { value: item.arguments ?? null },
        category: 'other',
      };
    case 'collabAgentToolCall': {
      const subAgentName = resolveCollabAgentName(item, state);
      return {
        type: 'tool_use',
        id: item.id,
        name: 'Task',
        input: {
          subagent_type: subAgentName,
          agent: subAgentName,
          tool: item.tool ?? 'spawnAgent',
          prompt: item.prompt ?? '',
          model: item.model ?? undefined,
          receiverThreadIds: item.receiverThreadIds ?? [],
        },
        category: 'collaboration',
      };
    }
    default:
      return null;
  }
}

function adaptSubAgentActivity(
  item: CodexThreadItem,
  state: AdapterState,
): ConversationEvent[] {
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
    category: 'collaboration',
  }])];
}

function completeTerminalSubAgents(
  item: CodexThreadItem,
  state: AdapterState,
): ConversationEvent[] {
  const terminal = new Set(['completed', 'interrupted', 'errored', 'shutdown', 'notFound']);
  const events: ConversationEvent[] = [];
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

function closeAllSubAgents(state: AdapterState, interrupted: boolean): ConversationEvent[] {
  const events: ConversationEvent[] = [];
  for (const toolId of state.activeSubAgentToolIds.values()) {
    events.push(assistantEvent(state, [{
      type: 'tool_result',
      tool_use_id: toolId,
      content: interrupted ? 'Parent turn interrupted' : 'Parent turn completed',
      is_error: interrupted,
    }]));
  }
  state.activeSubAgentToolIds.clear();
  return events;
}

function resolveCollabAgentName(
  item: CodexThreadItem,
  state: AdapterState,
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
  const name = extension ? file.slice(0, -extension.length) : file;
  return name || undefined;
}

function toolResultBlock(item: CodexThreadItem): Extract<ContentBlock, { type: 'tool_result' }> | null {
  if (!item.id) return null;
  switch (item.type) {
    case 'commandExecution':
      return {
        type: 'tool_result',
        tool_use_id: item.id,
        content: item.aggregatedOutput ?? '',
        is_error: item.status === 'failed' || item.status === 'declined' || (item.exitCode ?? 0) !== 0,
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
        content: stringifySafe({ status: item.status, receiverThreadIds: item.receiverThreadIds ?? [] }),
        is_error: item.status === 'failed' || item.status === 'declined',
      };
    default:
      return null;
  }
}

function assistantEvent(state: AdapterState, content: ContentBlock[]): ConversationEvent {
  return {
    type: 'assistant',
    provider: 'codex',
    providerThreadId: state.threadId,
    providerTurnId: state.turnId,
    status: 'in_progress',
    model: state.model,
    content,
  };
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
