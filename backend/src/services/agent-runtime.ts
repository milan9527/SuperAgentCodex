/**
 * Agent Runtime Provider — abstraction layer for swappable AI agent backends.
 *
 * Consumers program against the `AgentRuntime` interface. `AGENT_RUNTIME`
 * selects the primary implementation:
 *
 *   "claude"    → ClaudeAgentService
 *   "codex"     → local Codex app-server
 *   "agentcore" → Codex app-server in AgentCore
 *   "openclaw"  → OpenClawProvider
 *
 * Codex/AgentCore deployments add invocation-level routing: supported Bedrock
 * OpenAI Responses models stay on the primary Codex runtime, while LiteLLM
 * selections use the retained Claude Agent SDK runtime. All implementations
 * emit the same ConversationEvent contract.
 */

import type {
  ConversationEvent,
  AgentConfig,
  MCPServerSDKConfig,
} from './agent-types.js';
import type { SkillForWorkspace } from './workspace-manager.js';

// Re-export shared types so consumers can import from this module only
export type {
  AgentConfig,
  AnyMCPServerConfig,
  ContentBlock,
  ConversationEvent,
  MCPServerInProcessConfig,
  MCPServerSDKConfig,
  TokenUsage,
} from './agent-types.js';

// ---------------------------------------------------------------------------
// Runtime-agnostic options (superset of what each provider needs)
// ---------------------------------------------------------------------------

export interface AgentRuntimeOptions {
  agentId: string;
  sessionId?: string;
  /** Provider-specific session ID for resume (Claude session ID, OpenClaw conversation ID, etc.) */
  providerSessionId?: string;
  /** Provider-neutral alias for runtimes that persist a thread rather than a session. */
  providerThreadId?: string;
  message: string;
  organizationId: string;
  userId: string;
  /** Pre-provisioned workspace path (local providers only). */
  workspacePath?: string;
  /** Business scope ID (required for AgentCore runtime). */
  scopeId?: string;
  /** Bounded platform history used only when provider-native resume is unavailable. */
  history?: AgentHistoryMessage[];
  /** Workspace-relative image paths attached to the current user turn. */
  imagePaths?: string[];
  /** Technical custom-agent name required by an explicit platform mention. */
  requestedAgentName?: string;
}

export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ---------------------------------------------------------------------------
// AgentRuntime interface
// ---------------------------------------------------------------------------

export interface AgentRuntime {
  readonly name: string;

  /**
   * Stream a conversation turn. Yields ConversationEvents compatible with
   * the existing SSE protocol so chat.service doesn't need to change its
   * event handling.
   */
  runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>,
  ): AsyncGenerator<ConversationEvent>;

  /** Disconnect / abort a running session. */
  disconnectSession(sessionId: string): Promise<void>;

  /** Disconnect all active sessions (graceful shutdown). */
  disconnectAll(): Promise<number>;

  /** Number of currently active sessions. */
  readonly activeSessionCount: number;

  /** Check if a session is currently tracked. */
  hasSession(sessionId: string): boolean;
}
