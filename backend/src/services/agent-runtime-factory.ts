/**
 * Agent Runtime Factory — resolves the active AgentRuntime based on config.
 *
 * Usage:
 *   import { agentRuntime } from './agent-runtime-factory.js';
 *   yield* agentRuntime.runConversation(options, agentConfig, skills);
 */

import type { AgentRuntime } from './agent-runtime.js';
import { ClaudeAgentRuntime } from './agent-runtime-claude.js';
import { AgentCoreAgentRuntime } from './agent-runtime-agentcore.js';
import { OpenClawAgentRuntime } from './agent-runtime-openclaw.js';
import { BerriAIAgentRuntime } from './agent-runtime-berriai.js';
import { CodexAgentRuntime } from './agent-runtime-codex.js';
import { ModelRoutingAgentRuntime } from './agent-runtime-router.js';

export type AgentRuntimeName = 'claude' | 'codex' | 'agentcore' | 'openclaw' | 'berriai';

function resolveRuntimeName(): AgentRuntimeName {
  const env = process.env.AGENT_RUNTIME?.toLowerCase().trim();
  if (env === 'berriai') return 'berriai';
  if (env === 'openclaw') return 'openclaw';
  if (env === 'agentcore') return 'agentcore';
  if (env === 'codex') return 'codex';
  if (!env || env === 'claude') return 'claude';
  throw new Error(`Unsupported AGENT_RUNTIME: ${env}`);
}

function createRuntime(name: AgentRuntimeName): AgentRuntime {
  switch (name) {
    case 'berriai':
      return new BerriAIAgentRuntime();
    case 'openclaw':
      return new OpenClawAgentRuntime();
    case 'agentcore':
      return new AgentCoreAgentRuntime();
    case 'codex':
      return new CodexAgentRuntime();
    case 'claude':
    default:
      return new ClaudeAgentRuntime();
  }
}

const runtimeName = resolveRuntimeName();

/** The active agent runtime singleton. */
const configuredRuntime = createRuntime(runtimeName);
export const agentRuntime: AgentRuntime = (
  runtimeName === 'codex' || runtimeName === 'agentcore'
)
  ? new ModelRoutingAgentRuntime(configuredRuntime, new ClaudeAgentRuntime())
  : configuredRuntime;

console.log(
  `[agent-runtime] Using "${agentRuntime.name}" primary runtime`
  + `${agentRuntime instanceof ModelRoutingAgentRuntime ? ' with LiteLLM Claude routing' : ''}`,
);
