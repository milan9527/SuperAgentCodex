/**
 * Provider-neutral wire contract between the backend and AgentCore container.
 */

export interface AgentPayload {
  prompt: string;
  /** Codex thread id to resume. Kept separate from the AgentCore runtime session id. */
  provider_thread_id?: string;
  /** Legacy alias accepted during rollout. */
  session_id?: string;
  chat_session_id?: string;
  scope_id?: string;
  org_id?: string;
  agent_id?: string;
  requested_agent_name?: string;
  system_prompt?: string;
  model?: string;
  model_provider?: 'amazon-bedrock' | 'openai';
  aws_region?: string;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  mcp_servers?: Record<string, MCPServerConfig>;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  image_paths?: string[];
  workspace_s3_bucket?: string;
  workspace_s3_prefix?: string;
  backend_api_url?: string;
  backend_api_key?: string;
}

export interface MCPServerConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean };

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  total_cost_usd: number;
}

export interface AgentEvent {
  type: 'session_start' | 'assistant' | 'result' | 'heartbeat' | 'error';
  provider?: 'codex';
  session_id?: string;
  provider_thread_id?: string;
  provider_turn_id?: string;
  status?: 'in_progress' | 'completed' | 'interrupted' | 'failed';
  content?: ContentBlock[];
  model?: string;
  code?: string;
  message?: string;
  duration_ms?: number;
  num_turns?: number;
  token_usage?: TokenUsage;
  diff?: string;
  plan?: Array<{ step: string; status: string }>;
}
