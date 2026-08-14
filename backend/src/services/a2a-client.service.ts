/**
 * A2A Client — Unified Agent-to-Agent invocation interface.
 *
 * Internal agents use local:// fast path (in-process call).
 * External agents use HTTPS (standard A2A protocol over HTTP).
 * The Orchestrator doesn't need to know the difference.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentEndpoint {
  agentId: string;
  name: string;
  displayName: string;
  role: string;
  endpoint: string;        // "local://{agentId}" or "https://..."
  capabilities?: string[];
}

export interface A2ATaskResult {
  taskId: string;
  status: 'completed' | 'failed' | 'timeout';
  content: string;
  durationMs: number;
  agentId: string;
  agentName: string;
}

export interface A2ATaskStatus {
  taskId: string;
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  result?: string;
}

export interface A2AAgentCard {
  name: string;
  displayName: string;
  description: string;
  capabilities?: string[];
  skills?: Array<{ id: string; name: string; description: string }>;
}

export interface SendTaskParams {
  agentId: string;
  endpoint: string;
  message: string;
  sessionId?: string;
  organizationId: string;
  callerAgentId?: string;
  systemPromptOverride?: string;
  timeoutMs?: number;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class A2AClient {
  /**
   * Send a task to an agent via A2A protocol.
   * Automatically routes to local or remote handler based on endpoint scheme.
   */
  async sendTask(params: SendTaskParams): Promise<A2ATaskResult> {
    const start = Date.now();

    try {
      if (params.endpoint.startsWith('local://')) {
        return await this.invokeLocal(params, start);
      } else {
        return await this.invokeRemote(params, start);
      }
    } catch (err: any) {
      return {
        taskId: params.sessionId || crypto.randomUUID(),
        status: 'failed',
        content: `A2A invocation failed: ${err.message}`,
        durationMs: Date.now() - start,
        agentId: params.agentId,
        agentName: params.agentId,
      };
    }
  }

  /**
   * Query task status (for async/polling scenarios).
   */
  async getTask(params: {
    agentId: string;
    endpoint: string;
    taskId: string;
    organizationId: string;
  }): Promise<A2ATaskStatus> {
    if (params.endpoint.startsWith('local://')) {
      // Local tasks are synchronous — if we have a result, it's completed
      return { taskId: params.taskId, status: 'completed' };
    }

    // Remote: HTTP GET
    const url = `${params.endpoint}/tasks/${params.taskId}`;
    const resp = await fetch(url, {
      headers: this.buildRemoteHeaders(params.organizationId),
    });

    if (!resp.ok) {
      return { taskId: params.taskId, status: 'failed' };
    }

    const data = await resp.json() as any;
    return {
      taskId: params.taskId,
      status: data.status ?? 'processing',
      result: data.result ?? undefined,
    };
  }

  /**
   * Get Agent Card (capability description).
   */
  async getAgentCard(params: {
    agentId: string;
    endpoint: string;
    organizationId: string;
  }): Promise<A2AAgentCard | null> {
    if (params.endpoint.startsWith('local://')) {
      return this.getLocalAgentCard(params.agentId, params.organizationId);
    }

    // Remote: HTTP GET
    const url = `${params.endpoint}/card`;
    try {
      const resp = await fetch(url, {
        headers: this.buildRemoteHeaders(params.organizationId),
      });
      if (!resp.ok) return null;
      return await resp.json() as A2AAgentCard;
    } catch {
      return null;
    }
  }

  // ── Local Fast Path ─────────────────────────────────────────────────────

  private async invokeLocal(params: SendTaskParams, startTime: number): Promise<A2ATaskResult> {
    const { prisma } = await import('../config/database.js');

    // Load agent to get its scope
    const agent = await prisma.agents.findFirst({
      where: { id: params.agentId, organization_id: params.organizationId },
    });

    if (!agent) {
      throw new Error(`Agent ${params.agentId} not found`);
    }

    const scopeId = agent.business_scope_id;
    if (!scopeId) {
      // No scope — fall back to bare LLM with system prompt only
      return this.invokeLocalBare(params, agent, startTime);
    }

    // Full configured agent runtime: workspace + skills + MCP.
    try {
      const { ChatService } = await import('./chat.service.js');
      const chatService = new ChatService();

      const result = await Promise.race([
        chatService.processMessage({
          businessScopeId: scopeId,
          message: params.systemPromptOverride
            ? `[System instruction: ${params.systemPromptOverride}]\n\n${params.message}`
            : params.message,
          organizationId: params.organizationId,
          userId: 'a2a-internal',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Local A2A timeout')), params.timeoutMs ?? 60000),
        ),
      ]);

      return {
        taskId: result.sessionId,
        status: 'completed',
        content: result.text,
        durationMs: Date.now() - startTime,
        agentId: params.agentId,
        agentName: agent.display_name,
      };
    } catch (err: any) {
      console.warn(`[a2a-client] Full runtime failed for ${agent.name}, falling back to bare LLM:`, err.message);
      return this.invokeLocalBare(params, agent, startTime);
    }
  }

  /**
   * Bare LLM fallback — used when agent has no scope or full runtime fails.
   */
  private async invokeLocalBare(params: SendTaskParams, agent: any, startTime: number): Promise<A2ATaskResult> {
    const systemPrompt = params.systemPromptOverride || agent.system_prompt || '';
    const { aiService } = await import('./ai.service.js');

    const response = await Promise.race([
      aiService.chatCompletion({
        system_prompt: systemPrompt || undefined,
        messages: [
          { role: 'user' as const, content: params.message },
        ],
        max_tokens: 4096,
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Local A2A timeout')), params.timeoutMs ?? 60000),
      ),
    ]);

    return {
      taskId: params.sessionId || crypto.randomUUID(),
      status: 'completed',
      content: response,
      durationMs: Date.now() - startTime,
      agentId: params.agentId,
      agentName: agent.display_name,
    };
  }

  private async getLocalAgentCard(agentId: string, organizationId: string): Promise<A2AAgentCard | null> {
    const { prisma } = await import('../config/database.js');

    const agent = await prisma.agents.findFirst({
      where: { id: agentId, organization_id: organizationId },
    });

    if (!agent) return null;

    return {
      name: agent.name,
      displayName: agent.display_name,
      description: agent.role || '',
      capabilities: agent.a2a_capabilities?.split(',').map((s: string) => s.trim()) ?? [],
    };
  }

  // ── Remote HTTP Path ────────────────────────────────────────────────────

  private async invokeRemote(params: SendTaskParams, startTime: number): Promise<A2ATaskResult> {
    const url = `${params.endpoint}/tasks/send`;

    const resp = await Promise.race([
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.buildRemoteHeaders(params.organizationId),
        },
        body: JSON.stringify({
          message: params.message,
          sessionId: params.sessionId,
          metadata: {
            callerAgentId: params.callerAgentId,
          },
        }),
      }),
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('Remote A2A timeout')), params.timeoutMs ?? 60000),
      ),
    ]);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Remote A2A returned ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json() as any;

    // If the remote returns immediately with a taskId (async), poll for result
    if (data.status === 'submitted' && data.taskId) {
      return this.pollRemoteTask(params, data.taskId, startTime);
    }

    // Synchronous response
    return {
      taskId: data.taskId || crypto.randomUUID(),
      status: 'completed',
      content: data.agent_response || data.result || JSON.stringify(data),
      durationMs: Date.now() - startTime,
      agentId: params.agentId,
      agentName: data.agentName || params.agentId,
    };
  }

  private async pollRemoteTask(
    params: SendTaskParams,
    taskId: string,
    startTime: number,
  ): Promise<A2ATaskResult> {
    const timeout = params.timeoutMs ?? 60000;
    const pollInterval = 2000;

    while (Date.now() - startTime < timeout) {
      await new Promise(r => setTimeout(r, pollInterval));

      const status = await this.getTask({
        agentId: params.agentId,
        endpoint: params.endpoint,
        taskId,
        organizationId: params.organizationId,
      });

      if (status.status === 'completed') {
        return {
          taskId,
          status: 'completed',
          content: status.result || '',
          durationMs: Date.now() - startTime,
          agentId: params.agentId,
          agentName: params.agentId,
        };
      }

      if (status.status === 'failed') {
        return {
          taskId,
          status: 'failed',
          content: status.result || 'Remote task failed',
          durationMs: Date.now() - startTime,
          agentId: params.agentId,
          agentName: params.agentId,
        };
      }
    }

    return {
      taskId,
      status: 'timeout',
      content: 'Remote A2A task timed out',
      durationMs: Date.now() - startTime,
      agentId: params.agentId,
      agentName: params.agentId,
    };
  }

  private buildRemoteHeaders(organizationId: string): Record<string, string> {
    // TODO: Look up API key for the target organization
    // For now, use a placeholder
    return {
      'Authorization': `Bearer ${organizationId}`,
      'User-Agent': 'SuperAgent-A2A/1.0',
    };
  }
}

export const a2aClient = new A2AClient();
