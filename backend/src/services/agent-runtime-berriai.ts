/**
 * BerriAI Agent Runtime — invokes litellm-agent-platform self-hosted
 * K8s sandbox for isolated agent execution.
 *
 * Unlike AgentCore (AWS-managed microVMs), this runtime targets a
 * self-hosted litellm-agent-platform deployment where each agent session
 * runs in an isolated Kubernetes pod with vault proxy for secrets.
 *
 * Architecture:
 *   Backend → HTTP → litellm-agent-platform API → K8s Sandbox Pod
 *     ├── Coding agent (Claude Code / Codex / claude-agent-sdk)
 *     ├── Vault Proxy (secrets injection, no real keys exposed to agent)
 *     └── Workspace (git clone from repo_url)
 *
 * The platform exposes a REST + SSE API (Next.js App Router):
 *   POST /api/v1/managed_agents/agents                         — create agent
 *   POST /api/v1/managed_agents/agents/:id/session             — create session (async, returns immediately)
 *   GET  /api/v1/managed_agents/sessions/:id                   — poll session status
 *   POST /api/v1/managed_agents/sessions/:id/message           — send message (sync, blocks until reply)
 *   POST /api/v1/managed_agents/sessions/:id/message_stream    — send message (SSE streaming)
 *   DELETE /api/v1/managed_agents/sessions/:id                  — destroy session
 *
 * Auth: Bearer token (MASTER_KEY from the platform's .env)
 *
 * Required env vars:
 *   BERRIAI_API_URL    — base URL of the litellm-agent-platform (e.g. http://localhost:3000)
 *   BERRIAI_API_KEY    — MASTER_KEY for Bearer auth
 *
 * Optional env vars:
 *   BERRIAI_NAMESPACE       — K8s namespace for sandboxes (informational, platform controls this)
 *   BERRIAI_SANDBOX_IMAGE   — override harness image (platform controls this via K8S_HARNESS_IMAGE)
 *   BERRIAI_TIMEOUT_SECONDS — session poll timeout (default: 120s)
 *   BERRIAI_WORKSPACE_SYNC  — workspace sync method: "s3" or "volume" (default: "s3")
 */

import { config } from '../config/index.js';
import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type {
  ConversationEvent,
  AgentConfig,
  ContentBlock,
  MCPServerSDKConfig,
} from './claude-agent.service.js';
import type { SkillForWorkspace } from './workspace-manager.js';

// ---------------------------------------------------------------------------
// litellm-agent-platform API types
// ---------------------------------------------------------------------------

/** Response from POST /api/v1/managed_agents/agents */
interface LAPAgent {
  id: string;
  name: string | null;
  model: string;
  prompt: string | null;
  harness_id: string;
  repo_url: string | null;
  branch: string;
}

/** Response from POST /api/v1/managed_agents/agents/:id/session */
interface LAPSession {
  id: string;
  agent_id: string;
  status: 'creating' | 'ready' | 'failed' | 'dead';
  sandbox_url: string | null;
  harness_session_id: string | null;
  response: LAPMessageResponse | null;
  failure_reason: string | null;
  phase: string | null;
  phase_detail: string | null;
}

/** Response from POST /api/v1/managed_agents/sessions/:id/message */
interface LAPMessageResponse {
  parts?: Array<LAPMessagePart>;
  [key: string]: unknown;
}

interface LAPMessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** SSE event from POST /api/v1/managed_agents/sessions/:id/message_stream */
interface LAPStreamEvent {
  type: 'ready' | 'harness_event' | 'done' | 'error';
  event?: {
    type: string;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  message?: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class BerriAIAgentRuntime implements AgentRuntime {
  readonly name = 'berriai';

  private activeSessions = new Map<string, AbortController>();
  /**
   * Cache of LAP agent IDs keyed by our internal agent config ID.
   * Avoids re-creating agents on every conversation turn.
   */
  private agentIdCache = new Map<string, string>();

  private get apiUrl(): string {
    const url = config.berriai.apiUrl;
    if (!url) throw new Error('BERRIAI_API_URL is not configured');
    return url.replace(/\/$/, ''); // strip trailing slash
  }

  private get apiKey(): string {
    const key = config.berriai.apiKey;
    if (!key) throw new Error('BERRIAI_API_KEY is not configured');
    return key;
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  // ---------------------------------------------------------------------------
  // AgentRuntime interface
  // ---------------------------------------------------------------------------

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    _skills: SkillForWorkspace[],
    _pluginPaths?: string[],
    _mcpServers?: Record<string, MCPServerSDKConfig>,
  ): AsyncGenerator<ConversationEvent> {
    // Step 1: Ensure a LAP agent exists for this agentConfig
    let lapAgentId: string;
    try {
      lapAgentId = await this.ensureAgent(agentConfig);
    } catch (err) {
      yield {
        type: 'error',
        code: 'BERRIAI_AGENT_CREATE_ERROR',
        message: `Failed to create BerriAI agent: ${err instanceof Error ? err.message : String(err)}`,
        suggestedAction: 'Check BERRIAI_API_URL and BERRIAI_API_KEY configuration',
      };
      return;
    }

    // Step 2: Create a session (sandbox pod)
    let lapSession: LAPSession;
    try {
      lapSession = await this.createSession(lapAgentId, options);
    } catch (err) {
      yield {
        type: 'error',
        code: 'BERRIAI_SESSION_CREATE_ERROR',
        message: `Failed to create BerriAI session: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    // Step 3: Wait for session to become ready
    try {
      lapSession = await this.waitForReady(lapSession.id);
    } catch (err) {
      yield {
        type: 'error',
        code: 'BERRIAI_SESSION_TIMEOUT',
        message: `BerriAI session did not become ready: ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    // Emit session_start
    yield {
      type: 'session_start',
      sessionId: lapSession.id,
    };

    // Step 4: Send message via streaming endpoint
    const abortController = new AbortController();
    this.activeSessions.set(options.sessionId ?? lapSession.id, abortController);

    try {
      yield* this.streamMessage(lapSession.id, options.message, abortController.signal);
    } finally {
      this.activeSessions.delete(options.sessionId ?? lapSession.id);
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const controller = this.activeSessions.get(sessionId);
    if (controller) {
      controller.abort();
      this.activeSessions.delete(sessionId);
    }
  }

  async disconnectAll(): Promise<number> {
    const count = this.activeSessions.size;
    for (const [id, controller] of this.activeSessions) {
      controller.abort();
      this.activeSessions.delete(id);
    }
    return count;
  }

  get activeSessionCount(): number {
    return this.activeSessions.size;
  }

  hasSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Agent management
  // ---------------------------------------------------------------------------

  /**
   * Ensure a LAP agent exists for the given config. Uses a local cache
   * to avoid re-creating on every turn.
   */
  private async ensureAgent(agentConfig: AgentConfig): Promise<string> {
    const cached = this.agentIdCache.get(agentConfig.id);
    if (cached) return cached;

    // Create a new agent on the platform
    const body = {
      name: agentConfig.displayName || agentConfig.name,
      model: agentConfig.model ?? config.claude.model ?? 'anthropic/claude-sonnet-4-6',
      prompt: agentConfig.systemPrompt ?? undefined,
      harness_id: 'claude-agent-sdk', // Use Claude Agent SDK harness
    };

    console.log(
      `[berriai-runtime] Creating LAP agent name="${body.name}" model="${body.model}"`,
    );

    const response = await fetch(`${this.apiUrl}/api/v1/managed_agents/agents`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const agent = await response.json() as LAPAgent;
    this.agentIdCache.set(agentConfig.id, agent.id);
    console.log(`[berriai-runtime] Created LAP agent id=${agent.id}`);
    return agent.id;
  }

  // ---------------------------------------------------------------------------
  // Session management
  // ---------------------------------------------------------------------------

  /**
   * Create a new session on the platform. Returns immediately with
   * status="creating"; caller must poll until ready.
   */
  private async createSession(
    lapAgentId: string,
    options: AgentRuntimeOptions,
  ): Promise<LAPSession> {
    const body: Record<string, unknown> = {
      title: `super-agent-${options.sessionId ?? 'ephemeral'}`,
    };

    // Pass initial_prompt only if we want the agent to start working immediately
    // (we don't — we'll send the message separately via /message_stream)

    console.log(
      `[berriai-runtime] Creating session for agent=${lapAgentId} ` +
      `org=${options.organizationId} user=${options.userId}`,
    );

    const response = await fetch(
      `${this.apiUrl}/api/v1/managed_agents/agents/${lapAgentId}/session`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json() as LAPSession;
  }

  /**
   * Poll session status until ready or timeout.
   */
  private async waitForReady(sessionId: string, timeoutMs?: number): Promise<LAPSession> {
    const timeout = timeoutMs ?? (config.berriai.timeoutSeconds * 1000);
    const start = Date.now();
    const pollInterval = 3000; // 3s as recommended by LAP docs

    while (Date.now() - start < timeout) {
      const response = await fetch(
        `${this.apiUrl}/api/v1/managed_agents/sessions/${sessionId}`,
        { method: 'GET', headers: this.headers },
      );

      if (!response.ok) {
        throw new Error(`Failed to poll session status: HTTP ${response.status}`);
      }

      const session = await response.json() as LAPSession;

      if (session.status === 'ready') {
        console.log(`[berriai-runtime] Session ${sessionId} is ready`);
        return session;
      }

      if (session.status === 'failed' || session.status === 'dead') {
        throw new Error(
          `Session ${sessionId} entered ${session.status} state: ${session.failure_reason ?? 'unknown reason'}`,
        );
      }

      // Still creating — log phase progress
      if (session.phase) {
        console.log(
          `[berriai-runtime] Session ${sessionId} phase=${session.phase}` +
          (session.phase_detail ? ` (${session.phase_detail})` : ''),
        );
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    throw new Error(`Session ${sessionId} did not become ready within ${timeout}ms`);
  }

  // ---------------------------------------------------------------------------
  // Message streaming
  // ---------------------------------------------------------------------------

  /**
   * Send a message via the streaming endpoint and yield ConversationEvents.
   *
   * The /message_stream endpoint returns SSE with these event types:
   *   { type: "ready" }                          — upstream connected, prompt fired
   *   { type: "harness_event", event: {...} }    — agent bus events (token deltas, tool use, etc.)
   *   { type: "done" }                           — agent loop completed
   *   { type: "error", message: "..." }          — failure
   */
  private async *streamMessage(
    sessionId: string,
    message: string,
    signal: AbortSignal,
  ): AsyncGenerator<ConversationEvent> {
    const response = await fetch(
      `${this.apiUrl}/api/v1/managed_agents/sessions/${sessionId}/message_stream`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ text: message }),
        signal,
      },
    );

    if (!response.ok) {
      const text = await response.text();
      yield {
        type: 'error',
        code: 'BERRIAI_MESSAGE_ERROR',
        message: `Message stream failed: HTTP ${response.status} — ${text}`,
      };
      return;
    }

    // Parse SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assistantText = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are terminated by \n\n
        for (;;) {
          const idx = buffer.indexOf('\n\n');
          if (idx < 0) break;
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trimStart();
            if (!raw) continue;

            let event: LAPStreamEvent;
            try {
              event = JSON.parse(raw) as LAPStreamEvent;
            } catch {
              continue;
            }

            const mapped = this.mapStreamEvent(event);
            if (mapped) {
              // Accumulate text for the final result
              if (mapped.type === 'assistant' && mapped.content) {
                for (const block of mapped.content) {
                  if (block.type === 'text' && block.text) {
                    assistantText += block.text;
                  }
                }
              }
              yield mapped;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit result event
    yield {
      type: 'result',
      sessionId,
    };
  }

  /**
   * Fallback: send a message synchronously (blocks until agent completes).
   * Used when streaming is not needed or as a simpler alternative.
   */
  async sendMessageSync(
    sessionId: string,
    message: string,
  ): Promise<LAPMessageResponse> {
    const response = await fetch(
      `${this.apiUrl}/api/v1/managed_agents/sessions/${sessionId}/message`,
      {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ text: message }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Message failed: HTTP ${response.status} — ${text}`);
    }

    return await response.json() as LAPMessageResponse;
  }

  // ---------------------------------------------------------------------------
  // Event mapping
  // ---------------------------------------------------------------------------

  /**
   * Map a litellm-agent-platform SSE event to our ConversationEvent format.
   *
   * LAP stream events:
   *   { type: "ready" }                       → heartbeat (agent is processing)
   *   { type: "harness_event", event: {...} } → assistant content
   *   { type: "done" }                        → null (handled by caller)
   *   { type: "error", message: "..." }       → error event
   */
  private mapStreamEvent(event: LAPStreamEvent): ConversationEvent | null {
    switch (event.type) {
      case 'ready':
        return { type: 'heartbeat' };

      case 'harness_event': {
        if (!event.event) return null;
        return this.mapHarnessEvent(event.event);
      }

      case 'done':
        // The caller handles the result event emission
        return null;

      case 'error':
        return {
          type: 'error',
          code: 'BERRIAI_STREAM_ERROR',
          message: event.message ?? 'Unknown streaming error',
        };

      default:
        return null;
    }
  }

  /**
   * Map an opencode/harness bus event to a ConversationEvent.
   *
   * Harness bus events include:
   *   - message.part.updated: token deltas / tool use updates
   *   - session.idle: agent loop returned control
   *   - message.created: new message in the thread
   */
  private mapHarnessEvent(event: Record<string, unknown>): ConversationEvent | null {
    const eventType = event.type as string;

    if (eventType === 'message.part.updated') {
      const part = (event.properties as Record<string, unknown>)?.part as LAPMessagePart | undefined;
      if (!part) return null;

      const content: ContentBlock[] = [];
      if (part.type === 'text' && part.text) {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'tool-invocation' || part.type === 'tool_use') {
        content.push({
          type: 'tool_use',
          id: (part.id ?? part.toolInvocationId ?? '') as string,
          name: (part.toolName ?? part.name ?? 'unknown') as string,
          input: (part.input ?? part.args ?? {}) as Record<string, unknown>,
        });
      } else if (part.type === 'tool-result' || part.type === 'tool_result') {
        content.push({
          type: 'tool_result',
          tool_use_id: (part.toolInvocationId ?? part.tool_use_id ?? '') as string,
          content: (part.text ?? part.content ?? '') as string,
          is_error: (part.isError ?? part.is_error ?? false) as boolean,
        });
      }

      if (content.length === 0) return null;

      return {
        type: 'assistant',
        content,
      };
    }

    if (eventType === 'session.idle') {
      // Agent loop completed — no separate event needed, caller handles via 'done'
      return null;
    }

    // Other events (message.created, etc.) — skip
    return null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle — destroy session
  // ---------------------------------------------------------------------------

  /**
   * Destroy a sandbox session. Deletes the Sandbox CR and marks session dead.
   */
  async destroySession(sessionId: string): Promise<void> {
    try {
      await fetch(
        `${this.apiUrl}/api/v1/managed_agents/sessions/${sessionId}`,
        { method: 'DELETE', headers: this.headers },
      );
      console.log(`[berriai-runtime] Destroyed session ${sessionId}`);
    } catch (err) {
      console.warn(
        `[berriai-runtime] Failed to destroy session ${sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
