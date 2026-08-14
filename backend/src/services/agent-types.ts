import type { ResolvedModel } from './model-resolver.js';

export interface AgentConfig {
  id: string;
  name: string;
  displayName: string;
  systemPrompt: string | null;
  /** Runtime model identifier selected for this invocation. */
  model?: string;
  /** Fully resolved provider routing information. */
  resolvedModel?: ResolvedModel;
  organizationId: string;
  skillIds: string[];
  mcpServerIds: string[];
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      category?: 'command' | 'file' | 'mcp' | 'web' | 'collaboration' | 'other';
    }
  | { type: 'tool_result'; tool_use_id: string; content: string | null; is_error: boolean };

export function appendContentBlocks(target: ContentBlock[], incoming: ContentBlock[]): void {
  for (const block of incoming) {
    const previous = target[target.length - 1];
    if (previous?.type === 'text' && block.type === 'text') {
      previous.text += block.text;
    } else {
      target.push(block);
    }
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
}

export interface ConversationEvent {
  type: 'session_start' | 'assistant' | 'result' | 'heartbeat' | 'error' | 'preview_ready';
  provider?: 'claude' | 'codex' | 'agentcore' | 'openclaw' | 'berriai';
  sessionId?: string;
  providerThreadId?: string;
  providerTurnId?: string;
  status?: 'in_progress' | 'completed' | 'interrupted' | 'failed';
  content?: ContentBlock[];
  model?: string;
  durationMs?: number;
  numTurns?: number;
  code?: string;
  message?: string;
  suggestedAction?: string;
  appId?: string;
  url?: string;
  appName?: string;
  speakerAgentName?: string;
  speakerAgentAvatar?: string | null;
  tokenUsage?: TokenUsage;
  diff?: string;
  plan?: Array<{ step: string; status: string }>;
}

/** Serializable MCP server configuration accepted by local and remote runtimes. */
export interface MCPServerSDKConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

/** In-process MCP server supported only by runtimes with an explicit bridge. */
export interface MCPServerInProcessConfig {
  type: 'sdk';
  name: string;
  instance: unknown;
}

export type AnyMCPServerConfig = MCPServerSDKConfig | MCPServerInProcessConfig;
