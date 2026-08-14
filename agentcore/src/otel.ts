/**
 * OpenTelemetry instrumentation for the Codex app-server runtime, following the
 * SAES / AgentCore Evaluation OTEL contract (see CustomEval
 * .agents/skills/otel-eval-contract).
 *
 * Why hand-rolled: Codex drives Bedrock through a CLI subprocess
 * SUBPROCESS, so AgentCore's auto-instrumentation never sees the model calls —
 * nothing is captured for free. We satisfy the contract by hand:
 *   - one root span per invocation (= one trace per turn) carrying
 *     `session.id`, `gen_ai.prompt`, `gen_ai.completion`;
 *   - one OTEL event per turn with roled input/output message bodies (the shape
 *     SAES's role-aware recovery reads);
 *   - per tool call, Bedrock-Converse-shaped `toolUse`/`toolResult` event bodies
 *     so the tool supplement can recover the trajectory.
 *
 * Export: when AGENT_OBSERVABILITY_ENABLED=true the AgentCore Runtime provides
 * an OTLP receiver (localhost:4318) that forwards to CloudWatch/X-Ray using the
 * OTEL_EXPORTER_OTLP_*_HEADERS (x-aws-log-group etc.) set on the container. We
 * export spans + logs over OTLP/HTTP-protobuf to that endpoint. When the flag is
 * off (local dev without a collector) instrumentation is a no-op unless a test
 * harness installs in-memory providers first.
 */

import {
  trace,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type Tracer,
  type Context,
  SpanStatusCode,
} from '@opentelemetry/api';
import { logs, type Logger } from '@opentelemetry/api-logs';
import type { TokenUsage } from './types.js';

// This is a custom Codex integration, not the OpenAI Agents SDK. Use a truthful
// scope and standard GenAI/OpenInference attributes so AgentCore's generic
// framework support can classify the spans.
const SCOPE = 'superagent.instrumentation.codex';
const OBSERVABILITY_ENABLED = process.env.AGENT_OBSERVABILITY_ENABLED === 'true';

/**
 * Observability setup is NOT done here. The AWS Distro for OpenTelemetry (ADOT)
 * Node package is preloaded via the container entrypoint:
 *
 *   node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register dist/index.js
 *
 * That CJS `register` hook (loaded before this ESM app) installs the global
 * TracerProvider + LoggerProvider and the SigV4-signed OTLP export pipeline that
 * delivers to CloudWatch (the /aws/bedrock-agentcore/runtimes/<id> log group),
 * reading AGENT_OBSERVABILITY_ENABLED + OTEL_* from the environment.
 *
 * Why not a self-built NodeTracerProvider: there is no standalone OTLP collector
 * on AgentCore Runtime ("ADOT Collector not supported for agent observability")
 * and plain OTEL-JS exporters can't SigV4-sign to CloudWatch. ADOT's register
 * provides both. It's CJS (works via --require) so it coexists with our ESM app
 * and the ESM application.
 *
 * This module therefore only EMITS spans/events through the global OTEL API,
 * which resolves to whatever provider `register` installed (or a no-op provider
 * when observability is disabled / register wasn't preloaded).
 */
export async function initOtel(): Promise<void> {
  if (OBSERVABILITY_ENABLED) {
    console.log('[otel] Observability enabled — emitting spans/events via the ADOT global provider');
  }
}

function getTracer(): Tracer {
  return trace.getTracer(SCOPE);
}

function getLogger(): Logger {
  return logs.getLogger(SCOPE);
}

/**
 * Extract an OTEL parent Context from the inbound invocation's HTTP headers.
 *
 * AgentCore's platform emits its own `AgentCore.Runtime.Invoke` span and can
 * forward the W3C `traceparent` (and X-Ray `X-Amzn-Trace-Id`) into the
 * container. Without extracting it, our root span starts a NEW trace, so one
 * turn shows as two disconnected traces (platform span + our span) under the
 * same session. Extracting it makes our `agent.invocation` a CHILD of the
 * platform span — one connected trace per turn (the console groups a session's
 * work into one trace this way).
 *
 * ADOT's `register` hook installs the global propagator (W3C + X-Ray), so
 * `propagation.extract` understands both header formats. Returns undefined when
 * no usable trace context is present (→ caller starts a fresh root, today's
 * behavior). Never throws.
 */
export function parentContextFromHeaders(headers: Record<string, unknown> | undefined): Context | undefined {
  if (!OBSERVABILITY_ENABLED || !headers) return undefined;
  try {
    // Normalize to a lowercase string→string carrier (getter is case-sensitive).
    const carrier: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      carrier[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    }
    if (!carrier.traceparent && !carrier['x-amzn-trace-id']) return undefined;
    const ctx = propagation.extract(ROOT_CONTEXT, carrier);
    const sc = trace.getSpanContext(ctx);
    // Only use it if extraction yielded a valid remote span context.
    return sc && sc.traceId ? ctx : undefined;
  } catch {
    return undefined;
  }
}

/** Emit an OTEL log record (used as an "event" — the contract's event bodies). */
function emitEvent(name: string, body: unknown, span?: Span): void {
  try {
    const ctx = span?.spanContext();
    getLogger().emit({
      // event.name marks this log record as a semantic event.
      attributes: { 'event.name': name },
      body: body as never,
      ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
    });
  } catch {
    /* telemetry must never throw into the agent path */
  }
}

/**
 * Handle to the active invocation span so tool calls and the final answer can
 * attach to it. Returned by beginInvocation; caller must call end().
 */
export interface InvocationTrace {
  /**
   * Record a tool call as a child span. Called when the tool_use block is seen
   * (root span still active). `callId` is the SDK's tool_use id — pass it so a
   * later tool_result can be matched via recordToolResult. `result` is usually
   * '' at this point (results arrive later / out of band).
   */
  recordTool(name: string, input: unknown, result: unknown, callId?: string): void;
  /** Attach a tool's result to its already-recorded span (matched by callId). */
  recordToolResult(callId: string, result: unknown): void;
  /**
   * Finalize with the assistant's final answer + optional model / token usage.
   * When a model and/or usage is present, ALSO emits a terminal `chat {model}`
   * child span carrying the token counters + model — the LLM client span the
   * AgentCore GenAI console reads model + token metrics from. The invoke_agent
   * span alone does not populate those columns.
   */
  end(answer: string, opts?: { isError?: boolean; model?: string; numTurns?: number; tokenUsage?: TokenUsage }): void;
}

/** Provider constant for Codex running through its Amazon Bedrock provider. */
const PROVIDER = 'aws.bedrock';

/**
 * Stamp the four aws/spans token counters the AgentCore console sums. These
 * `gen_ai.usage.*` keys drive the SESSION/space-level token metrics
 * (ApplicationSignals InputTokens/OutputTokens); the platform's span processor
 * also derives `aws.genai.token_count_total` from them. The SDK's
 * `cache_creation_input_tokens` maps to the convention's `cache_write` counter.
 * `usage` is our TokenUsage shape (see types.ts). Missing values default to 0.
 *
 * AgentCore can consume these standard GenAI counters through generic framework
 * support even though the Codex subprocess is not auto-instrumented.
 */
function stampUsage(span: Span, usage: TokenUsage): void {
  span.setAttribute('gen_ai.usage.input_tokens', Math.trunc(usage.input_tokens ?? 0));
  span.setAttribute('gen_ai.usage.output_tokens', Math.trunc(usage.output_tokens ?? 0));
  span.setAttribute('gen_ai.usage.cache_read_input_tokens', Math.trunc(usage.cache_read_input_tokens ?? 0));
  span.setAttribute('gen_ai.usage.cache_write_input_tokens', Math.trunc(usage.cache_creation_input_tokens ?? 0));
}

/**
 * Emit one terminal `chat {model}` LLM span as a child of the invocation.
 *
 * Codex drives Bedrock through a subprocess, so no per-LLM-call
 * span is captured for free — but the AgentCore GenAI console reads its model
 * and token columns from a span with `gen_ai.operation.name=chat`. Without this
 * span the dashboard shows no model / no tokens even though invoke_agent carries
 * them. The SDK reports usage once per query (ResultMessage.usage, summed across
 * turns), so this is a single honest aggregate span per turn. No-op when neither
 * model nor usage is present.
 */
function emitChatSpan(
  sessionId: string,
  parentCtx: Context,
  opts?: { model?: string; numTurns?: number; tokenUsage?: TokenUsage },
): void {
  if (!opts?.model && !opts?.tokenUsage) return;
  try {
    const model = opts.model ?? 'unknown';
    const chatSpan = getTracer().startSpan(`chat ${model}`, undefined, parentCtx);
    chatSpan.setAttribute('gen_ai.operation.name', 'chat');
    chatSpan.setAttribute('gen_ai.system', PROVIDER);
    chatSpan.setAttribute('gen_ai.provider.name', PROVIDER);
    chatSpan.setAttribute('gen_ai.request.model', model);
    chatSpan.setAttribute('session.id', sessionId);
    if (opts.tokenUsage) stampUsage(chatSpan, opts.tokenUsage);
    if (opts.numTurns != null) chatSpan.setAttribute('gen_ai.agent.num_turns', Math.trunc(opts.numTurns));
    chatSpan.setStatus({ code: SpanStatusCode.OK });
    chatSpan.end();
  } catch { /* telemetry must never throw into the agent path */ }
}

/**
 * Start a root span for one agent invocation (= one trace per turn) and stamp
 * the three contract attributes. Returns a no-op handle when observability is
 * off. Never throws — telemetry failures must not affect the agent.
 */
export function beginInvocation(sessionId: string, prompt: string, parentCtx?: Context): InvocationTrace {
  if (!OBSERVABILITY_ENABLED) return NOOP_TRACE;

  let span: Span;
  let rootCtx: ReturnType<typeof trace.setSpan>;
  try {
    // If the caller extracted a parent context from the inbound headers (the
    // platform's AgentCore.Runtime.Invoke span), start our root INSIDE it so the
    // whole turn is one connected trace. Otherwise start a fresh root (the span
    // gets its own trace — the pre-propagation behavior).
    const startCtx = parentCtx ?? context.active();
    span = getTracer().startSpan('agent.invocation', undefined, startCtx);
    rootCtx = trace.setSpan(startCtx, span);

    // --- Agent Traces UI rendering (gen_ai.* semantic conventions) ---
    // gen_ai.operation.name categorizes the span so the UI renders it as an
    // agent invocation and shows input/output; without it the span is a bare
    // skeleton. input/output.messages carry the content the UI displays.
    span.setAttribute('gen_ai.operation.name', 'invoke_agent');
    span.setAttribute('gen_ai.provider.name', PROVIDER);
    span.setAttribute('gen_ai.agent.name', 'super-agent');
    span.setAttribute('gen_ai.input.messages', JSON.stringify([{ role: 'user', content: [{ type: 'text', text: prompt }] }]));

    span.setAttribute('session.id', sessionId);          // contract item 1
    span.setAttribute('gen_ai.prompt', prompt);          // contract item 2

    // OpenInference attributes provide a second standards-compatible path for
    // AgentCore generic framework evaluation.
    span.setAttribute('openinference.span.kind', 'AGENT');
    span.setAttribute('input.value', prompt);
    span.setAttribute('llm.input_messages.0.message.role', 'user');
    span.setAttribute('llm.input_messages.0.message.content', prompt);
  } catch {
    return NOOP_TRACE;
  }

    // Open tool spans awaiting their result (keyed by the SDK tool_use id).
    // Kept open so a later tool_result can attach; closed in end() otherwise.
    const openToolSpans = new Map<string, Span>();
    // Guard against a double end() (e.g. a retry path calling end() twice on the
    // same handle): the first end() finalizes; later ones are ignored so we never
    // re-close the span, overwrite good token totals with zeros, or emit a
    // duplicate chat span.
    let ended = false;
  return {
    recordTool(name, input, result, callId) {
      try {
        // A real CHILD span (parented to the invocation via rootCtx) so the tool
        // call shows as its own step in the trace UI. execute_tool + gen_ai.tool.*
        // are what the UI/eval read; input/output.value mirror it for OpenInference.
        const inputText = typeof input === 'string' ? input : JSON.stringify(input);
        const resultText = result == null || result === '' ? '' : (typeof result === 'string' ? result : JSON.stringify(result));
        const id = callId || `tooluse_${Math.random().toString(16).slice(2, 18)}`;
        const toolSpan = getTracer().startSpan(`execute_tool ${name}`, undefined, rootCtx);
        toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
        // Child spans don't inherit the root's attributes; stamp session.id here
        // too so tool spans are queryable by session and group correctly for
        // SESSION-level evaluation (trace UI groups by traceId regardless).
        toolSpan.setAttribute('session.id', sessionId);
        toolSpan.setAttribute('gen_ai.tool.name', name);
        toolSpan.setAttribute('gen_ai.tool.call.id', id);
        toolSpan.setAttribute('gen_ai.tool.call.arguments', inputText);
        toolSpan.setAttribute('openinference.span.kind', 'TOOL');
        toolSpan.setAttribute('tool.name', name);
        toolSpan.setAttribute('input.value', inputText);
        if (resultText) {
          toolSpan.setAttribute('gen_ai.tool.call.result', resultText);
          toolSpan.setAttribute('output.value', resultText);
        }
        emitEvent('gen_ai.tool.request', { content: [{ toolUse: { toolUseId: id, name, input } }] }, span);
        if (resultText) {
          emitEvent('gen_ai.tool.result', { content: [{ toolResult: { toolUseId: id, content: [{ text: resultText }] } }] }, span);
          toolSpan.setStatus({ code: SpanStatusCode.OK });
          toolSpan.end();
        } else {
          // Leave open for a possible recordToolResult; end() closes it if not.
          openToolSpans.set(id, toolSpan);
        }
      } catch { /* ignore */ }
    },
    recordToolResult(callId, result) {
      try {
        const toolSpan = openToolSpans.get(callId);
        if (!toolSpan) return;
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        toolSpan.setAttribute('gen_ai.tool.call.result', resultText);
        toolSpan.setAttribute('output.value', resultText);
        toolSpan.setStatus({ code: SpanStatusCode.OK });
        toolSpan.end();
        openToolSpans.delete(callId);
        emitEvent('gen_ai.tool.result', { content: [{ toolResult: { toolUseId: callId, content: [{ text: resultText }] } }] }, span);
      } catch { /* ignore */ }
    },
    end(answer, opts) {
      if (ended) return;
      ended = true;
      try {
        // Close any tool spans whose result never arrived.
        for (const ts of openToolSpans.values()) {
          try { ts.setStatus({ code: SpanStatusCode.OK }); ts.end(); } catch { /* ignore */ }
        }
        openToolSpans.clear();
        // Agent Traces UI output content.
        span.setAttribute('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: [{ type: 'text', text: answer }] }]));
        span.setAttribute('gen_ai.completion', answer);   // contract item 3
        span.setAttribute('output.value', answer);        // OpenInference
        span.setAttribute('llm.output_messages.0.message.role', 'assistant');
        span.setAttribute('llm.output_messages.0.message.content', answer);
        // Stamp model + usage on the invoke_agent span too (queryable there),
        // and emit the dedicated `chat` LLM span the console reads for its
        // model/token columns.
        if (opts?.model) span.setAttribute('gen_ai.request.model', opts.model);
        if (opts?.numTurns != null) span.setAttribute('gen_ai.agent.num_turns', opts.numTurns);
        if (opts?.tokenUsage) stampUsage(span, opts.tokenUsage);
        span.setStatus({ code: opts?.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
        emitChatSpan(sessionId, rootCtx, opts);
      } catch { /* ignore */ } finally {
        try { span.end(); } catch { /* ignore */ }
      }
    },
  };
}

const NOOP_TRACE: InvocationTrace = {
  recordTool() { /* no-op */ },
  recordToolResult() { /* no-op */ },
  end() { /* no-op */ },
};
