/**
 * Claude Agent Runtime — wraps the existing ClaudeAgentService behind the
 * AgentRuntime interface. This is a thin adapter; all real logic stays in
 * claude-agent.service.ts.
 */

import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type { ConversationEvent, AgentConfig, MCPServerSDKConfig } from './agent-types.js';
import {
  claudeAgentService,
  type ClaudeAgentService,
} from './claude-agent.service.js';
import type { SkillForWorkspace } from './workspace-manager.js';

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude';
  private readonly sessionAliases = new Map<string, string>();

  constructor(
    private readonly service: Pick<
      ClaudeAgentService,
      'runConversation' | 'disconnectSession' | 'disconnectAll' | 'activeClientCount' | 'hasSession'
    > = claudeAgentService,
  ) {}

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>
  ): AsyncGenerator<ConversationEvent> {
    try {
      const providerThreadId = options.providerThreadId ?? options.providerSessionId;
      const invoke = (
        claudeSessionId?: string,
      ): AsyncGenerator<ConversationEvent> => this.service.runConversation(
        {
          agentId: options.agentId,
          sessionId: options.sessionId,
          claudeSessionId,
          message: options.message,
          organizationId: options.organizationId,
          userId: options.userId,
          workspacePath: options.workspacePath,
          history: options.history,
          imagePaths: options.imagePaths,
        },
        agentConfig,
        skills,
        pluginPaths,
        mcpServers,
      );

      const pending: ConversationEvent[] = [];
      let resumeFailedBeforeTurn = false;
      let emittedProviderContent = false;

      for await (const event of invoke(providerThreadId)) {
        if (!providerThreadId || !options.history?.length || emittedProviderContent) {
          this.trackSessionAlias(options.sessionId, event);
          yield event;
          continue;
        }

        pending.push(event);
        if (event.type === 'assistant') {
          emittedProviderContent = true;
          for (const buffered of pending.splice(0)) {
            this.trackSessionAlias(options.sessionId, buffered);
            yield buffered;
          }
        } else if (
          event.type === 'result'
          && event.status === 'failed'
          && (event.numTurns ?? 0) === 0
          && (event.durationMs ?? 0) === 0
        ) {
          resumeFailedBeforeTurn = true;
        } else if (event.type === 'result' && event.status !== 'failed') {
          emittedProviderContent = true;
          for (const buffered of pending.splice(0)) {
            this.trackSessionAlias(options.sessionId, buffered);
            yield buffered;
          }
        }
      }

      if (resumeFailedBeforeTurn && !emittedProviderContent) {
        console.warn(
          `[claude-runtime] Native resume failed before a turn started; replaying bounded history for ${providerThreadId}`,
        );
        pending.length = 0;
        for await (const event of invoke(undefined)) {
          this.trackSessionAlias(options.sessionId, event);
          yield event;
        }
      } else {
        for (const buffered of pending) {
          this.trackSessionAlias(options.sessionId, buffered);
          yield buffered;
        }
      }
    } finally {
      if (options.sessionId) this.sessionAliases.delete(options.sessionId);
      // Fire-and-forget: carry agent-made workspace changes back to scope DB.
      // Mirrors the behavior of the AgentCore runtime, but reads from local disk
      // since the claude runtime keeps workspaces on the local filesystem and
      // does not sync to S3.
      if (
        options.workspacePath &&
        options.sessionId &&
        options.scopeId &&
        options.scopeId !== 'default'
      ) {
        const orgId = options.organizationId;
        const scopeId = options.scopeId;
        const sessionId = options.sessionId;
        const workspacePath = options.workspacePath;
        (async (): Promise<void> => {
          try {
            const { carryForwardService } = await import('./carry-forward.service.js');
            const result = await carryForwardService.syncFromSession(orgId, scopeId, sessionId, {
              localWorkspacePath: workspacePath,
            });
            if (
              result.skills.length > 0 ||
              result.agents.length > 0 ||
              result.claudeMdUpdated ||
              result.settingsUpdated ||
              result.hooksUpdated ||
              result.systemPromptUpdated
            ) {
              console.log(
                `[claude-runtime] Carry-forward complete: skills=${result.skills.join(',')}, agents=${result.agents.join(',')}, systemPrompt=${result.systemPromptUpdated}`
              );
            }
          } catch (err) {
            console.warn(
              '[claude-runtime] Carry-forward failed:',
              err instanceof Error ? err.message : err
            );
          }
        })();
      }
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    return this.service.disconnectSession(this.sessionAliases.get(sessionId) ?? sessionId);
  }

  async disconnectAll(): Promise<number> {
    return this.service.disconnectAll();
  }

  get activeSessionCount(): number {
    return this.service.activeClientCount;
  }

  hasSession(sessionId: string): boolean {
    const providerSessionId = this.sessionAliases.get(sessionId);
    return Boolean(providerSessionId) || this.service.hasSession(sessionId);
  }

  private trackSessionAlias(
    platformSessionId: string | undefined,
    event: ConversationEvent,
  ): void {
    if (event.type === 'session_start' && event.sessionId && platformSessionId) {
      this.sessionAliases.set(platformSessionId, event.sessionId);
    }
  }
}
