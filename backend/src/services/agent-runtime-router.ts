import type {
  AgentRuntime,
  AgentRuntimeOptions,
} from './agent-runtime.js';
import type {
  AgentConfig,
  ConversationEvent,
  MCPServerSDKConfig,
} from './agent-types.js';
import type { SkillForWorkspace } from './workspace-manager.js';
import { isCodexBedrockModel } from './model-resolver.js';
import { AppError, ErrorCodes } from '../middleware/errorHandler.js';

export class UnsupportedAgentModelError extends AppError {
  constructor(modelId: string) {
    super(
      `The selected Bedrock model is not supported by an agent runtime: ${modelId}. `
      + 'Select an OpenAI Responses model, or configure Claude through a LiteLLM provider.',
      400,
      ErrorCodes.AGENT_MODEL_RUNTIME_UNSUPPORTED,
    );
    this.name = 'UnsupportedAgentModelError';
  }
}

export interface RuntimeResolver {
  resolveRuntime(agentConfig: AgentConfig): AgentRuntime;
}

/**
 * Routes each invocation without changing the platform's configured primary
 * runtime. Bedrock OpenAI Responses models use Codex. LiteLLM models use the
 * retained Claude Agent SDK runtime, which supports Anthropic-compatible
 * gateways without changing the Codex-native Bedrock path.
 */
export class ModelRoutingAgentRuntime implements AgentRuntime, RuntimeResolver {
  readonly name: string;

  constructor(
    private readonly primaryRuntime: AgentRuntime,
    private readonly claudeRuntime: AgentRuntime,
  ) {
    this.name = primaryRuntime.name;
  }

  resolveRuntime(agentConfig: AgentConfig): AgentRuntime {
    const resolved = agentConfig.resolvedModel;
    if (resolved?.provider === 'litellm') return this.claudeRuntime;

    const modelId = resolved?.modelId ?? agentConfig.model;
    if (!modelId || isCodexBedrockModel(modelId)) {
      return this.primaryRuntime;
    }
    throw new UnsupportedAgentModelError(modelId!);
  }

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>,
  ): AsyncGenerator<ConversationEvent> {
    yield* this.resolveRuntime(agentConfig).runConversation(
      options,
      agentConfig,
      skills,
      pluginPaths,
      mcpServers,
    );
  }

  async disconnectSession(sessionId: string): Promise<void> {
    await Promise.allSettled([
      this.primaryRuntime.disconnectSession(sessionId),
      this.claudeRuntime.disconnectSession(sessionId),
    ]);
  }

  async disconnectAll(): Promise<number> {
    const results = await Promise.all([
      this.primaryRuntime.disconnectAll(),
      this.claudeRuntime.disconnectAll(),
    ]);
    return results[0] + results[1];
  }

  get activeSessionCount(): number {
    return this.primaryRuntime.activeSessionCount + this.claudeRuntime.activeSessionCount;
  }

  hasSession(sessionId: string): boolean {
    return this.primaryRuntime.hasSession(sessionId) || this.claudeRuntime.hasSession(sessionId);
  }
}

export function resolveInvocationRuntime(
  runtime: AgentRuntime,
  agentConfig: AgentConfig,
): AgentRuntime {
  const resolver = runtime as AgentRuntime & Partial<RuntimeResolver>;
  return typeof resolver.resolveRuntime === 'function'
    ? resolver.resolveRuntime(agentConfig)
    : runtime;
}
