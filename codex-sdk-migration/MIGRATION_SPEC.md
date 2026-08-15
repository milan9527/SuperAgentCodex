# Claude Agent SDK to Codex Migration Specification

Status: Implementation and validation complete; controlled default rollout pending

Date: 2026-08-14

Owners: Platform Runtime, Backend, Infrastructure, Frontend

## 1. Executive Summary

Super Agent will add a Codex-backed runtime behind the existing
`AgentRuntime` interface, validate it alongside the Claude runtime, and then
make Codex the default through a controlled rollout.

The migration is not a package-name replacement. The current implementation
depends on Claude-specific sessions, content blocks, hooks, workspace files,
subagent conventions, plugins, model routing, and environment variables.
Those dependencies must be converted at explicit compatibility boundaries.

The implemented target uses:

- Codex app-server over a local `stdio` child process for interactive chat
  thread creation, continuation, resume,
  approvals, cancellation, and full-fidelity event streaming.
- The same app-server protocol inside the AgentCore container, so local and
  remote execution share thread, event, cancellation, image, and MCP semantics.
- The existing backend SSE contract during the compatibility phase.
- Codex project conventions: `AGENTS.md`, `.agents/skills`,
  `.codex/agents/*.toml`, and `.codex/config.toml`.
- The Codex `amazon-bedrock` provider when AWS Bedrock is selected.
- Invocation-level hybrid model routing: Bedrock OpenAI Responses models run
  natively through Codex/AgentCore, while administrator-approved models from
  a LiteLLM provider run through the retained Claude Agent SDK adapter.

Direct Bedrock Claude model IDs are deliberately not sent to Codex. In a
Codex/AgentCore deployment they fail before turn start with
`AGENT_MODEL_RUNTIME_UNSUPPORTED`; Claude models must be configured through a
LiteLLM provider. Existing deployed AgentCore Runtimes must not be updated or
deleted by this migration.

### 1.1 Implementation record

As of the detailed audit on 2026-08-14:

- Provider-neutral runtime, thread, turn, item, error, usage, and terminal
  contracts are implemented across chat and non-chat consumers.
- Local and AgentCore execution both use pinned `codex-cli 0.146.0`
  app-server over JSONL stdio. The checked-in schema bundle is reproducibly
  generated and `npm run codex:schema:check` fails on protocol drift.
- Start, cross-process resume, bounded history replay, explicit interrupt,
  timeout interrupt, crash recovery, terminal uniqueness, local images, stdio
  MCP, collaboration/subagents, plans, diffs, and token usage are covered by
  automated tests and real model runs.
- App-server requests initiated by the server, including approval requests,
  are rejected by the unattended platform client. Reserved, audited platform
  MCP servers may be auto-approved; tenant MCP servers may not impersonate
  those reserved names.
- Codex and AgentCore workspaces use only `AGENTS.md`,
  `.agents/skills/*`, `.codex/*`, and provider-neutral `.runtime/*`.
  Legacy Claude workspaces are verified, merged, and migrated before
  `CLAUDE.md` and `.claude/*` are removed.
- Generated memory instructions are capability-aware. `AGENTS.md` references
  only memory files backed by current scope/user records; a workspace with no
  memories has no memory-read instruction, and stale `memories/` directories
  are removed during refresh. Workspace layout version `3` forces existing
  sessions to pick up this correction.
- AgentCore serializes warm-container invocations around the shared mounted
  workspace, uses a per-platform-session `CODEX_HOME`, restores into a clean
  workspace, and restores environment variables after each invocation.
- S3 restore, deletion reconciliation, diff creation, local sync-back, and
  carry-forward are fail-closed. A terminal success event is not emitted until
  these operations are acknowledged.
- Subagent skill guidance is derived from the current agent-to-skill
  relationship when `.codex/agents/*.toml` is rendered. It is never persisted
  into the agent business prompt. Carry-forward strips platform-generated
  guidance before comparison and persistence, preventing repeated
  `Relevant project skills...` lines across workspace generations.
- Workspace sync rejects path traversal and symlink escapes independently of
  model hooks. Codex runs with `workspace-write`; model-initiated network
  access and writes outside the workspace are blocked.
- Workflow generation and patching emit server-validated structures.
  Workflow execution accumulates split progress markers, reports each step
  exactly once, interrupts on timeout, and never silently falls back from
  Codex/AgentCore to direct Bedrock.
- Scope generation, digital-twin generation, skill scanning, mention routing,
  subagent speaker mapping, and IM event aggregation use the standard runtime
  contract and propagate runtime errors.
- Claude plugins are not silently accepted. Under Codex they are reported as
  unsupported and cannot be newly attached; historical bindings remain
  removable.
- The frontend supports image-only submissions, provider-side stop,
  runtime-compatible model filtering, Codex-native workspace paths, stable
  SSE terminal metadata, and same-origin API/SSE/WebSocket proxying.
- Model-provider responses expose the actual invocation target and both the
  administrator allowlist and its runtime-compatible subset. Chat, Agent, and
  Scope selectors consume only that subset. The LiteLLM live catalog is
  admin-only configuration input and is never exposed directly as a Chat
  model list.
- Vulnerable `xlsx` was replaced with `read-excel-file`. Safe `.xlsx`
  multi-sheet preview remains supported; legacy `.xls` and `.xlsb` files are
  download-only.
- The backend Docker build is strict, installs pinned Codex CLI, uses an
  isolated writable `CODEX_HOME`, and retains the Claude CLI only for the
  explicit rollback window.
- `infra/scripts/deploy-codex-agentcore-new.sh` is create-only, uses an
  immutable image tag and dedicated role, and has no Runtime update/delete or
  backend configuration mutation path.
- `infra/scripts/deploy-full-ecs.sh` now performs a fail-closed, immutable
  deployment of the CDK stack, AgentCore Runtime, database migrations, seed,
  backend ECS service, and frontend CloudFront distribution. A failed phase
  stops the release. A later run may reuse only an explicitly supplied,
  validated `READY` Runtime ARN; it never discovers and updates a Runtime by
  name.
- The full ECS deployment creates or verifies stack-dedicated AgentCore
  Browser and Code Interpreter resources. The Browser enables
  `browserSigning` for Web Bot Auth. Existing resources are reused only after
  role, network, signing, and readiness validation; the scripts never
  update or delete them.
- Existing AgentCore Runtimes were not updated or deleted, and no GitHub push
  was performed during this audit.

### 1.2 Validation record

Authoritative isolated AgentCore audit Runtime:

- Runtime ARN:
  `arn:aws:bedrock-agentcore:us-east-1:632930644527:runtime/SuperAgentCodexAudit20260814C-gTn0nOGpPv`
- Runtime version/status: `1`, `READY`
- Immutable image:
  `632930644527.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore-codex:codex-audit-20260814c`
- Image digest:
  `sha256:92efd4ac6379a2bba1ed7d3c0a14ed1b021027d5e998b2c72a833b15760c3e59`
- Runtime Region/model: `us-east-1`, `openai.gpt-5.4`
- Workspace bucket/Region:
  `superagentdev9-workspace-632930644527`, `us-east-1`
- Runtime metadata requires MMDSv2. The execution role includes
  `bedrock-mantle:CreateInference` for the Bedrock OpenAI Responses path.
- Backend default runtime configuration was not changed.

Repository and container gates after subagent context normalization:

- Backend production build and `531/531` automated tests passed.
- Frontend production build and `602/602` automated tests passed.
- AgentCore production build and `17/17` automated tests passed.
- Backend and frontend ESLint blocking-error checks passed.
- Backend, frontend, and AgentCore full dependency audits each report
  `0 vulnerabilities`.
- The strict backend container build passed. The resulting image runs as a
  non-root user with Node `20.20.2`, `codex-cli 0.146.0`, writable isolated
  `CODEX_HOME`, and loadable Sharp native bindings.
- Codex app-server schema comparison passed against the bundle generated by
  `codex-cli 0.146.0`.

Real local Codex app-server audit:

- Amazon Bedrock model `openai.gpt-5.4` in `us-east-1` passed.
- Real stdio MCP lifecycle and filesystem side effect passed.
- The same provider thread resumed after the app-server process was replaced.
- A real PNG sent as `localImage` was interpreted correctly.
- Terminal-event uniqueness and workspace-write behavior passed.
- Audit provider thread:
  `019ffe97-ec28-7aa0-a606-e5682c33e798`.

Real AgentCore Runtime C audit:

- Base chat, Bash/file tools, S3 proof, diff, deletion reconciliation, and
  `workspace_sync` before the unique terminal event passed.
- Image input passed.
- Writes outside `/workspace` and model-initiated network access were blocked.
- Managed Browser and Code Interpreter MCP tools completed successfully.
- HTTP cancellation interrupted the active turn; the same provider thread
  then opened a successful recovery turn.
- Workflow progress MCP ran from the container runtime asset. Execution
  produced exactly one `step_start`, one `step_complete`, one `done`, zero
  errors, and no fallback.
- Mention/subagent execution emitted spawn, child-thread, wait, and mapped
  speaker events rather than degrading to a main-agent-only response.
- Workflow generation preserved `humanApproval`; workflow patch generation
  produced server-validated `updateTitle` and `relayout` operations.
- Scope generation, digital-twin generation, and file-backed skill scanning
  completed through the real Runtime. The temporary audit records were
  removed after validation.

Real platform/browser audit:

- An isolated backend on port `3002` was configured for Runtime C, with a Vite
  frontend on port `5174` proxying to it. No persistent backend configuration
  was changed.
- Real login, model selection, session creation, streamed chat, tool events,
  provider thread/turn metadata, terminal status, persistence, and workspace
  APIs passed.
- The final browser run returned `42` successful business API responses,
  rendered the assistant marker, had no desktop or mobile horizontal overflow,
  and reported zero console, page, request, or non-2xx API errors.

Real hybrid model-routing audit:

- The LiteLLM provider live catalog returned `14` models, including
  `claude-sonnet-4.6` and multiple Claude Opus variants.
- Admin Settings persisted only `claude-opus-4.8` in the LiteLLM provider
  allowlist. The browser Chat picker displayed that model and
  `openai.gpt-5.4`, without leaking the remaining live catalog or direct
  Bedrock Claude providers.
- A direct API request for unapproved `claude-sonnet-4.6` failed before
  runtime start with HTTP `400 VALIDATION_ERROR`.
- `bedrock/us.anthropic.claude-sonnet-4-6` completed through the Claude Agent
  SDK with exact response `CLAUDE_TURN_ONE_OK`.
- A second turn resumed the same native Claude session
  `fb998ad3-2217-4743-8368-aa97d64ad5c5` and returned
  `CLAUDE_RESUME_OK`.
- A deliberately unavailable native Claude session produced a zero-turn resume
  failure. The adapter suppressed that stale terminal, replayed bounded
  platform history, opened replacement session
  `845fcf40-ab39-4f68-b4d1-5289e7085dc8`, and returned
  `LITELLM_FALLBACK_OK`.
- The same platform chat session then switched to Bedrock
  `openai.gpt-5.4`; AgentCore returned `CODEX_SWITCH_OK` and received four
  bounded platform-history messages for cross-runtime continuity.
- Persistence retained the Claude session/model separately while updating the
  active provider runtime and Codex thread. The workspace remained
  `AGENTS.md`/`.agents`/`.codex` only, and the host `~/.claude.json` was not
  modified because each Claude invocation uses an isolated config directory.
- Direct Bedrock Claude selection failed before turn start with HTTP `400` and
  `AGENT_MODEL_RUNTIME_UNSUPPORTED`, directing the caller to LiteLLM.
- Existing polluted subagent prompts were normalized atomically in the
  database, bumping affected scope configuration versions. Historical local
  and S3 agent TOML snapshots were normalized to one current skill-guidance
  line; a second cleanup pass changed zero files. Re-running carry-forward on
  the original affected session produced no agent changes and left both
  database prompts with zero generated guidance lines.

Real `us-east-1` ECS deployment audit:

- A new CloudFormation stack named `SuperAgentCodex` reached
  `UPDATE_COMPLETE`. It did not replace or mutate an existing application
  stack.
- Public application URL:
  `https://d3to1tdi7o7lzs.cloudfront.net`.
- The current AgentCore Runtime is
  `arn:aws:bedrock-agentcore:us-east-1:632930644527:runtime/SuperAgentCodexStream20260814-f9rR60E6i0`.
  It is `READY` and uses immutable image
  `632930644527.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore-codex:codex-20260814102650-53e1708`
  with digest
  `sha256:8da370c362cc3629b37dec8bbd5d1f491923769b8be753ccf01baf8ca8fcfbd9`.
- ECS runs immutable backend image
  `632930644527.dkr.ecr.us-east-1.amazonaws.com/super-agent-backend-superagentcodex:backend-20260814102814-53e1708`
  with digest
  `sha256:a5df34ff186f29579f5cd59f985d9814b2644eca6859a5900557a0264e4eb484`.
  The service is `1/1`, the task and container are healthy, and the ALB target
  and `/health/ready` are healthy.
- The first database migration task failed because the production image did
  not contain Prisma 7's `prisma.config.ts`. The deployment stopped before
  seed or ECS publication. The Docker image was fixed, validated with
  `prisma validate`, and the same stack safely resumed using the explicit
  `READY` Runtime ARN. Migrations and seed then completed successfully.
- RDS PostgreSQL `16.14` is private, encrypted, available, and retains seven
  days of backups. Redis `7.1.0` is available and uses an in-sync custom
  parameter group with `maxmemory-policy=noeviction`; a fresh backend task
  initialized Redis and all queues without BullMQ eviction warnings.
- Workspace, skills, avatar, and frontend S3 buckets are in `us-east-1`, use
  server-side encryption, and have all four Block Public Access settings
  enabled.
- Direct Runtime E2E passed with `openai.gpt-5.4`, Bash/file tools, S3 proof,
  diff, and terminal ordering. A second E2E through
  CloudFront -> ECS -> AgentCore returned exact marker
  `DEPLOYED_CODEX_CHAT_OK`, persisted provider thread/turn metadata, and wrote
  `DEPLOYED_CODEX_FILE_OK` into the new workspace bucket. The resulting
  workspace contained only the Codex layout.
- Existing AgentCore Runtimes were not updated or deleted during this
  deployment.
- The deployed ECS task now uses dedicated tools rather than the shared
  managed identifiers:
  `SuperAgentCodex_browser_webauth-fE2H1Jk9Cb` and
  `SuperAgentCodex_code_interpreter-H5bXUddPM2`. Both are `READY`, use the
  stable tool execution role and PUBLIC networking; Browser Web Bot Auth
  signing is enabled. Immutable Runtime versions may use a different Runtime
  execution role as long as that role is authorized to invoke the tools.
- `agentcore-tools` is wrapped by a platform stdio policy proxy. The proxy
  narrows the MCP `tools/list` schemas to the dedicated identifiers and
  overwrites any model-supplied `aws.browser.v1` or
  `aws.codeinterpreter.v1` value at `tools/call`. A real Browser session
  returned the dedicated identifier in both tool input and tool result.
- The same dedicated tools are available to LiteLLM Claude turns executed in
  the backend ECS task. The Claude adapter adds
  `mcp__agentcore-tools__*` to its SDK `allowedTools`, rewrites the workspace
  MCP record to the same policy proxy, and fails the turn explicitly if the
  SDK reports that the required server did not connect. The backend image
  uses Debian/glibc rather than Alpine/musl because the AWS Labs MCP package
  depends on a Playwright ARM64 manylinux wheel. The ECS task role grants the
  session actions against the actual dedicated resource ARN types,
  `browser-custom/*` and `code-interpreter-custom/*`.
- A real `claude-opus-4.7` turn through LiteLLM completed the complete Browser
  lifecycle against `https://twitter.com`: start, navigate, snapshot,
  evaluate, and stop. Twitter redirected to `https://x.com/` and returned the
  unauthenticated login page, which the agent reported accurately rather than
  claiming access to a signed-in timeline. The dedicated Browser session
  terminated normally.
- Chat SSE now coalesces adjacent text-only Codex deltas for at most `60 ms`
  or `32` characters. Tool, result, error, heartbeat, speaker-change, and
  terminal boundaries flush immediately. In a real Chinese response, the
  platform emitted `14` text events with chunk lengths mostly between `6`
  and `36` characters and only one single-character boundary event, while
  preserving Browser tool ordering and one completed terminal event.
- The same live turn successfully read `memories/lessons.md`; the tool result
  contained the expected lesson and `is_error=false`. Memory references are
  therefore present only when the corresponding generated file is available
  to the Runtime.
- A new Marketing session with zero scope memories generated `AGENTS.md`
  without a `## Memory` section or `memories/lessons.md` reference. A real
  platform turn then used Code Interpreter start/execute/stop and Browser
  start/navigate/stop, returned
  `CODE=83810205;TITLE=Example Domain`, completed successfully, and emitted no
  memory-file probe.

Conditional deployment findings:

- The deployed RDS instance is single-AZ and does not have deletion protection
  enabled. Its stack removal policy creates a snapshot, but production policy
  should decide whether to enable deletion protection and Multi-AZ.
- The deployed single-node Redis cluster does not use transit or at-rest
  encryption. Enabling either requires an explicitly planned client and
  replacement migration; it was not changed implicitly during validation.
- S3 versioning is not enabled. Public access remains blocked and server-side
  encryption is enabled, but retention/versioning policy must be decided
  before production data is treated as durable.
- The backend currently runs Node `20.20.2`. AWS SDK v3 reports that releases
  published after the first week of January 2027 will require Node 22, so the
  runtime image must move to Node 22 before that support boundary.
- Two enabled Slack records are test fixtures without a token or webhook.
  Standard IM event aggregation and fail-closed adapter behavior pass automated
  tests, but external Slack delivery cannot be claimed without valid test
  credentials.
- No enabled A2A deployment object exists; its code contract is covered, but
  there is no deployed peer for an external interoperability E2E.
- Codex-specific AWS Evaluate acceptance is not part of the current launch
  SLO. It must remain disabled or be separately validated before inclusion.
- Shadow comparison, production canary observation, SLO acceptance, and a
  rollback exercise have not been performed. Gate G therefore remains open,
  and Codex must not yet become the production default.

## 2. Decision

### 2.1 Runtime strategy

Create a new `CodexAgentRuntime` implementation. Do not rewrite
`chat.service.ts` around Codex protocol details.

The runtime implementation owns:

- Codex process/client lifecycle.
- Thread creation and resume.
- Turn execution and interruption.
- Codex-to-platform event translation.
- Workspace and runtime configuration.
- Active-turn tracking and graceful shutdown.

The rest of the platform continues to consume provider-neutral
`ConversationEvent` values.

### 2.2 Integration surface

Introduce a narrow app-server transport interface with one production
implementation:

- `CodexAppServerClient` for streamed conversations and AgentCore execution.

One client owns a thread for its entire lifetime. Never start a thread through
one process and attach a separate app-server process to observe or interrupt it.

Use app-server's stable local `stdio` transport. Its WebSocket transport is
experimental and is not a production dependency for this migration.

App-server is the required client for initial chat feature parity because this
product needs:

- Incremental agent-message events.
- Command and file-change lifecycle events.
- MCP tool-call lifecycle events.
- Structured approval requests.
- Explicit turn interruption.
- Diff, plan, and token-usage updates.
- Collaboration/subagent events.

Do not expose raw app-server JSON-RPC outside the Codex runtime module. A
future SDK version may replace the direct app-server client only after it
passes the same runtime contract suite.

### 2.3 Compatibility strategy

Use an expand-and-contract migration:

1. Add provider-neutral fields and contracts.
2. Add Codex without removing Claude.
3. Run contract, shadow, and canary tests.
4. Make Codex the default.
5. Remove Claude-only code after the rollback window.

## 3. Goals

- Support new and resumed Codex conversations.
- Preserve current chat HTTP and SSE behavior during migration.
- Preserve per-session isolated workspaces.
- Preserve skill, MCP, memory, document, and application-generation workflows.
- Preserve AgentCore execution and S3 workspace synchronization.
- Preserve cancellation, timeouts, reconnectable streams, and graceful
  shutdown.
- Preserve tenant isolation and least-privilege filesystem access.
- Preserve telemetry for turns, tools, token usage, errors, and latency.
- Support OpenAI models through Codex, including documented Bedrock-hosted
  OpenAI models.
- Support Claude and other Anthropic-compatible models exposed by an
  organization LiteLLM gateway through the retained Claude adapter.
- Permit per-organization and per-request runtime canaries.

## 4. Non-Goals

- Rewriting the frontend during the first compatibility phase.
- Sending direct Bedrock Claude model IDs through Codex.
- Making Claude plugins execute unchanged under Codex.
- Renaming every historical Claude reference before Codex is proven.
- Migrating unrelated direct Bedrock calls such as embeddings or specialized
  summarization unless they depend on the agent runtime.
- Replacing the platform's business-scope, memory, document, or persistence
  models.
- Introducing Codex cloud-hosted execution. This specification targets local
  Codex execution inside the existing backend or AgentCore container.

## 5. Current Architecture

### 5.1 Runtime boundary

The backend already exposes a swappable `AgentRuntime` interface:

```text
chat.service
    |
    v
AgentRuntime
    |-- ClaudeAgentRuntime
    |-- AgentCoreAgentRuntime
    |-- ModelRoutingAgentRuntime
    |-- OpenClawAgentRuntime
    `-- BerriAIAgentRuntime
```

The interface streams `ConversationEvent` objects and provides session
disconnect and activity methods.

### 5.2 Claude-specific dependencies

The active Claude path currently depends on:

- `@anthropic-ai/claude-agent-sdk` and `query()`.
- Claude session IDs and model-locked resume behavior.
- Claude `assistant`, `result`, `tool_use`, and `tool_result` message shapes.
- `PreToolUse`, `PostToolUse`, and `Stop` callback hooks.
- `CLAUDE.md` project instructions.
- `.claude/skills`, `.claude/agents`, `.claude/plugins`, and
  `.claude/settings.json`.
- `Task` tool calls for subagent identity.
- `ANTHROPIC_*` and `CLAUDE_CODE_*` environment variables.
- An Anthropic Messages compatibility proxy for non-Claude Bedrock models.
- `claude_session_id` and `claude_session_model` persistence fields.

### 5.3 Existing contracts to retain initially

- Chat routes and request schemas.
- SSE event envelope.
- `ConversationEvent` semantics.
- Stream registry and client reconnection.
- Workspace S3 layout during the compatibility phase.
- Business-scope selection and agent mentions.
- Message persistence and distillation.

## 6. Target Architecture

```text
Frontend
    |
    | existing HTTP + SSE
    v
chat.service
    |
    v
AgentRuntime
    |
    v
CodexAgentRuntime
    |
    v
CodexAppServerClient
    |
    v
local Codex runtime
    |
    | Responses-compatible provider
    v
OpenAI API or Amazon Bedrock
```

### 6.1 New modules

Recommended backend modules:

```text
backend/src/services/
  agent-runtime-codex.ts
  codex/
    codex-app-server-client.ts
    codex-event-adapter.ts
    codex-config-builder.ts
    codex-workspace-adapter.ts
    codex-errors.ts
```

Recommended AgentCore modules:

```text
agentcore/src/
  codex-runner.ts
  codex-event-adapter.ts
  codex-workspace-sync.ts
```

Shared protocol types should live in a provider-neutral module, not in
`claude-agent.service.ts`.

## 7. Provider-Neutral Runtime Contract

Move these types out of `claude-agent.service.ts`:

- `AgentConfig`
- `ConversationEvent`
- `ContentBlock`
- `TokenUsage`
- MCP server configuration accepted by the platform

Use provider-neutral names:

```ts
export interface AgentRuntimeOptions {
  agentId: string;
  sessionId?: string;
  providerThreadId?: string;
  message: string;
  organizationId: string;
  userId: string;
  workspacePath?: string;
  scopeId?: string;
}
```

Evolve the content model without breaking current consumers:

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      category?: 'command' | 'file' | 'mcp' | 'web' | 'collaboration' | 'other';
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string | null;
      is_error: boolean;
    };
```

Optional Codex-native data may be added to `ConversationEvent`, but all added
fields must be optional during compatibility:

```ts
interface ConversationEvent {
  provider?: 'claude' | 'codex' | 'agentcore' | 'openclaw' | 'berriai';
  providerThreadId?: string;
  providerTurnId?: string;
  status?: 'in_progress' | 'completed' | 'interrupted' | 'failed';
  diff?: string;
  plan?: Array<{ step: string; status: string }>;
}
```

## 8. Event Translation

The adapter must be deterministic and unit tested.

| Codex event or item | Platform event |
| --- | --- |
| Thread started/resumed | `session_start` with provider thread ID |
| Agent message delta/completed | `assistant` with text block |
| Command execution started | `assistant` with `tool_use` |
| Command execution completed | `assistant` with `tool_result` |
| File change started/completed | `assistant` tool blocks plus optional diff |
| MCP tool call started/completed | `assistant` tool blocks |
| Collaboration tool call | `assistant` tool blocks and speaker metadata |
| Turn completed | `result` |
| Turn interrupted | `result` with interrupted status |
| Turn failed/error | `error` |
| Token usage updated | `result.tokenUsage` or internal telemetry update |
| Plan updated | Optional `plan` field; omit from legacy SSE if unsupported |
| Diff updated | Optional `diff` field; retain server-side even if UI ignores it |

Rules:

- Item IDs become `tool_use.id`.
- Completion events must reference the same ID through `tool_use_id`.
- Text deltas must be emitted exactly once and in order.
- Completed items are authoritative when a delta stream and final item differ.
- Raw reasoning content must not be forwarded to clients by default.
- Approval requests are not normal assistant content and require a dedicated
  platform approval event before interactive approvals are enabled.
- Unknown Codex item types must be logged and ignored safely, not serialized as
  misleading text.

## 9. Thread and Turn Lifecycle

### 9.1 Persistence

Map:

```text
platform chat session -> Codex thread
platform user message -> Codex turn
```

Persist:

- Provider name.
- Provider thread ID.
- Model ID used for the latest turn.
- Optional provider metadata as JSON.

### 9.2 Resume

- Start a Codex thread when no provider thread ID exists.
- Resume the stored thread for later turns.
- If resume fails because state is unavailable, create a replacement thread
  and replay bounded platform history.
- Record a metric whenever fallback replay is used.
- Do not silently replay unbounded chat history.

### 9.3 Model changes

Do not assume Claude's model-lock behavior applies to Codex.

- Attempt a new turn with the newly selected supported model.
- If the runtime rejects a model change for an existing thread, start a new
  thread and retain platform conversation continuity through bounded history.
- Persist the actual model reported by the runtime.

### 9.4 Cancellation

Track active execution by platform session ID:

```ts
interface ActiveTurn {
  threadId: string;
  turnId?: string;
  interrupt(): Promise<void>;
  lastActivityAt: number;
}
```

`disconnectSession()` must interrupt the active turn, release process and
listener resources, and be idempotent. This is distinct from an HTTP client
disconnect: the current product deliberately lets server work continue after
the browser leaves and supports later stream reconnection. A new explicit stop
endpoint must call `disconnectSession()`; closing the SSE response must not.

## 10. Workspace Migration

### 10.1 Canonical Codex layout

Generate the project-owned files:

```text
workspace/
  AGENTS.md
  .agents/
    skills/
      <skill-name>/
        SKILL.md
  .codex/
    config.toml
    agents/
      <agent-name>.toml
  documents/
  memories/
  app/
```

Provider, authentication, and telemetry configuration must not be placed in
the project-owned `.codex/config.toml`. Codex ignores machine-local keys such
as `model_provider`, `model_providers`, auth, and `otel` in project config.
Generate those settings in the runtime-owned `$CODEX_HOME/config.toml` or pass
supported turn/start overrides.

### 10.2 File mapping

| Claude workspace | Codex workspace | Action |
| --- | --- | --- |
| `CLAUDE.md` | `AGENTS.md` | Convert generated instructions |
| `.claude/skills/*` | `.agents/skills/*` | Copy and validate skill metadata |
| `.claude/agents/*.md` | `.codex/agents/*.toml` | Convert frontmatter and prompt |
| `.claude/settings.json` | `.codex/config.toml` | Convert supported settings |
| `.claude/plugins/*` | Codex plugins or skills | Explicit compatibility review |
| `.claude/scope-system-prompt.md` | `.codex/scope-system-prompt.md` | Rename and update carry-forward |

During dual-runtime operation, provision both layouts from the same database
source. Do not generate the Codex tree by parsing generated Claude files.

### 10.3 `AGENTS.md`

Preserve:

- Scope description and instructions.
- Selected-agent behavior.
- Workspace security constraints.
- Application code directory requirements.
- Knowledge-base instructions.
- Memory instructions.
- Custom persistent section.

Remove Claude-specific tool names and replace them with Codex capabilities.
Keep `AGENTS.md` below the configured instruction byte limit, splitting nested
instructions when necessary.

### 10.4 Skills

- Preserve each existing `SKILL.md` folder and resources.
- Validate `name` and `description`.
- Replace Claude-only tool instructions.
- Convert references to `.claude` paths.
- Test discovery from `.agents/skills`.
- Keep skills provider-neutral where practical.

### 10.5 Subagents

Convert each database-backed subagent to a project-scoped Codex agent TOML.
Each file must include a description and developer instructions. Model and
reasoning settings should inherit by default unless the platform explicitly
configures them.

The frontend must not infer speaker identity from Claude's `Task` tool name.
Use Codex collaboration events and thread/agent metadata.

### 10.6 MCP

Build `.codex/config.toml` from the platform's normalized MCP records.

- Preserve stdio command, args, and environment.
- Preserve supported HTTP MCP endpoints.
- Validate startup timeout behavior.
- Keep credentials out of generated files where environment references are
  available.
- Test tenant-specific MCP visibility and authorization.

### 10.7 Plugins

Claude plugin directories are not assumed compatible.

Classify every enabled plugin:

1. Skills-only: migrate content into `.agents/skills`.
2. MCP-backed: register its MCP server and migrate workflow instructions.
3. Hook-based: rewrite as Codex hooks where equivalent.
4. Claude-specific executable or manifest: mark unsupported until ported.

Disable unsupported plugins explicitly and report them in migration results.

## 11. Model Provider and Authentication

### 11.1 OpenAI-hosted provider

Support a standard Codex/OpenAI authentication path where deployment policy
allows it. Credentials must be supplied through the deployment secret system,
not committed workspace files.

### 11.2 Amazon Bedrock

Codex supports an `amazon-bedrock` provider that uses the Bedrock
Responses-compatible path and AWS authentication.

Required runtime-owned configuration:

```toml
model_provider = "amazon-bedrock"
model_reasoning_effort = "high"
```

This belongs in `$CODEX_HOME/config.toml`, not the workspace's
`.codex/config.toml`.

Select only model IDs supported by Codex on Bedrock. Region availability and
IAM permission must be validated during startup health checks.

### 11.3 Removed compatibility assumption

The current Anthropic Messages proxy permits Claude Code to drive several
non-Anthropic Bedrock models. That behavior is not part of the Codex migration
contract.

The initial Codex runtime must reject unsupported model/provider combinations
before starting a turn. Do not send unsupported model IDs and rely on upstream
failure.

### 11.4 LiteLLM Claude routing

In a Codex or AgentCore deployment, runtime selection is per invocation:

| Provider/model | Runtime |
| --- | --- |
| Bedrock `openai.gpt-5*` | Codex or AgentCore primary runtime |
| Admin-approved LiteLLM model | Claude Agent SDK adapter |
| Direct Bedrock Claude or another unsupported Bedrock model | Reject before turn start |

The Claude adapter receives the selected LiteLLM base URL, decrypted API key,
and model name only for the invocation. It uses a session-isolated Claude
configuration directory, disables project/user setting discovery, injects
`AGENTS.md`, `.agents/skills`, and programmatic subagents, and does not create
`CLAUDE.md` or `.claude/*` in the canonical workspace.

Chat, IM, Canvas Agent nodes, and V2 Workflow execution resolve the actual
runtime from the selected request, agent, or scope model. Native provider
threads are resumed only by their owning runtime; switching runtime uses
bounded platform-history replay and retains the other runtime's thread fields.

Workspace MCP records are also normalized per invocation. The platform-owned
`agentcore-tools` server is rewritten to a policy proxy and explicitly added
to the Claude SDK MCP allowlist. It exposes only Browser and Code Interpreter,
locks calls to the configured dedicated identifiers, and treats connection
failure as a turn error. Tenant-defined MCP servers retain their own approval
and authorization boundaries.

### 11.5 Model picker

Add runtime capability metadata to model-provider responses:

```ts
interface RuntimeModelCapability {
  runtime: 'claude' | 'codex';
  provider: string;
  modelId: string;
  supported: boolean;
  supportsTools: boolean;
  supportsImages?: boolean;
  supportsReasoningEffort?: boolean;
}
```

The frontend displays only models present in the provider's
`allowed_model_ids` and compatible with the selected runtime. The backend
resolver enforces the same allowlist, so a caller cannot bypass it through a
direct API request. Live LiteLLM and Bedrock catalogs are available only to
administrators configuring a provider.

## 12. Security and Approvals

The current Claude implementation uses bypass permissions and custom command
blockers. Codex must use native sandbox and approval controls as the primary
boundary.

Initial server-side policy:

- Sandbox: workspace write.
- Writable root: the session workspace only.
- Network: disabled unless a workflow requires an approved destination.
- Approval policy: a noninteractive policy suitable for background execution,
  constrained by sandbox and hooks.
- Documents: read-only through filesystem policy when possible and prompt
  instructions as defense in depth.
- Parent workspace paths: unavailable.

Custom security hooks remain necessary for platform-specific rules that the
sandbox cannot express.

Interactive approvals are a later frontend feature. Before enabling them:

- Define SSE approval request and response schemas.
- Authenticate and authorize approval responses.
- Bind approvals to organization, session, thread, turn, and item.
- Expire pending requests.
- Audit every decision.

## 13. AgentCore Runtime

### 13.1 Container changes

- Install the pinned Codex runtime required by the selected SDK version.
- Replace the Claude Agent SDK dependency in the Codex image.
- Create a writable `CODEX_HOME` isolated to the invocation or tenant policy.
- Generate project-scoped Codex configuration inside `/workspace`.
- Supply AWS credentials through the existing task/AgentCore role.
- Set Bedrock region and provider configuration.
- Retain Node.js 22, which satisfies the TypeScript SDK requirement.

### 13.2 Stateless container behavior

AgentCore environments may be recycled between turns. Therefore:

- Persist the platform transcript in the database.
- Persist provider thread IDs, but do not depend on local thread files as the
  only source of continuity.
- Attempt native resume.
- Fall back to bounded history replay when the thread store is unavailable.
- Keep one telemetry trace per successful platform turn.

### 13.3 S3 synchronization

Do not depend solely on Codex file-change events. Commands can create or delete
files outside direct file-edit items.

Retain:

- A Git baseline before the turn.
- Final full workspace synchronization.
- Diff extraction.

Optionally add incremental sync from completed file-change items. Final sync is
the correctness mechanism and must be awaited or acknowledged before the
AgentCore invocation is considered complete. The current fire-and-forget Stop
hook is not a sufficient completion boundary.

## 14. Persistence Migration

### 14.1 Expand

Add nullable fields:

```text
provider_runtime
provider_thread_id
provider_thread_model
provider_thread_metadata
```

Keep `claude_session_id` and `claude_session_model` during dual operation.

### 14.2 Backfill

For existing records:

- Set `provider_runtime = 'claude'` when `claude_session_id` is present.
- Copy Claude session values into provider-neutral fields only if doing so does
  not change the active Claude code path.

Codex does not resume Claude session IDs. Existing user conversations continue
at the platform level, but the first Codex turn starts a Codex thread with
bounded history replay.

### 14.3 Contract

After Codex is the default and the rollback window closes:

- Remove writes to Claude-specific columns.
- Remove Claude-specific repository methods.
- Drop old columns in a separate migration.

## 15. Configuration

Extend backend configuration:

```text
AGENT_RUNTIME=codex
CODEX_HOME=<runtime-owned path>
CODEX_MODEL=<supported model id>
CODEX_MODEL_PROVIDER=amazon-bedrock|openai
CODEX_REASONING_EFFORT=medium|high|xhigh
CODEX_RESPONSE_TIMEOUT_MS=<milliseconds>
CODEX_MAX_CONCURRENT_SESSIONS=<count>
```

Add `codex` to the validated runtime enum. Do not reuse `config.claude` for new
settings.

During migration, define defaults independently:

```ts
config.claude
config.codex
```

## 16. Observability

Record these dimensions for every turn:

- Platform session ID.
- Provider runtime.
- Provider thread and turn IDs.
- Organization and agent IDs.
- Requested and actual model IDs.
- Provider name.
- Reasoning effort.
- Turn status.
- Resume or history-replay mode.
- Queue, startup, first-token, and total latency.
- Input, output, cache-read, and cache-write tokens when available.
- Command, file, MCP, web, and collaboration item counts.
- Approval counts and outcomes.
- Error category and upstream HTTP status when available.

Do not fabricate cost when the runtime does not supply it. Calculate estimated
cost only from a versioned pricing table and label it as estimated.

## 17. Error Mapping

Map Codex failures to stable platform errors:

| Codex condition | Platform code |
| --- | --- |
| Authentication failure | `AGENT_AUTH_ERROR` |
| Unsupported model/provider combination | `AGENT_MODEL_RUNTIME_UNSUPPORTED` |
| Usage limit | `AGENT_USAGE_LIMIT` |
| Context window exceeded | `AGENT_CONTEXT_LIMIT` |
| Sandbox denial | `AGENT_PERMISSION_DENIED` |
| MCP startup/call failure | `AGENT_TOOL_ERROR` |
| Turn interrupted | `AGENT_INTERRUPTED` |
| Upstream connection failure | `AGENT_PROVIDER_UNAVAILABLE` |
| Runtime process failure | `AGENT_RUNTIME_ERROR` |
| Unknown failure | `AGENT_EXECUTION_ERROR` |

Error messages returned to users must not expose absolute paths, credentials,
environment values, or internal infrastructure.

## 18. Implementation Phases

### Phase 0: Contract characterization

- Capture golden SSE streams for representative Claude conversations.
- Add tests for reconnect, timeout, cancellation, tool blocks, subagents, and
  result usage.
- Inventory active plugins, MCP servers, models, and workspace customizations.

Exit criterion: current behavior is represented by executable tests.

### Phase 1: Provider-neutral core

- Move shared runtime types out of the Claude service.
- Rename runtime parameters internally from session to provider thread.
- Add provider-neutral persistence fields.
- Keep external behavior unchanged.

Exit criterion: Claude tests pass with no API or UI regression.

### Phase 2: Codex local proof

- Pin and package the Codex CLI used by app-server.
- Implement app-server process management and event decoding.
- Implement interactive thread start, run, resume, interruption, and final
  response through app-server.
- Implement the SDK client only for an existing noninteractive job selected as
  a proof case.
- Translate text and completion events.
- Add runtime selection through `AGENT_RUNTIME=codex`.

Exit criterion: a local text-only multi-turn chat passes.

### Phase 3: Workspace conversion

- Generate `AGENTS.md`.
- Generate `.agents/skills`.
- Generate `.codex/agents`.
- Generate `.codex/config.toml` and MCP configuration.
- Update carry-forward and S3 paths.

Exit criterion: skills, memory, documents, MCP, and app generation work in an
isolated Codex workspace.

### Phase 4: Tool and stream parity

- Translate command, file, MCP, web, and collaboration items.
- Implement interruption and timeout.
- Preserve reconnectable streaming.
- Add native diff and token events.
- Map subagent speaker identity.

Exit criterion: compatibility tests pass against the existing frontend.

### Phase 5: AgentCore and Bedrock

- Build the Codex AgentCore image.
- Configure `amazon-bedrock`.
- Validate IAM, region, model access, concurrency, and cold start.
- Restore Git baseline, final S3 sync, and telemetry.

Exit criterion: AgentCore integration tests pass in a nonproduction account.

### Phase 6: Canary

- Enable Codex for internal organizations.
- Add per-organization/runtime feature flag.
- Compare success rate, latency, token use, tool success, and user feedback.
- Keep immediate rollback to Claude.

Exit criterion: canary SLOs hold for the agreed observation window.

### Phase 7: Default and cleanup

- Make Codex the default runtime.
- Retain Claude rollback during the stabilization window.
- Remove Claude-only dependencies, proxy paths, workspace generation, tests,
  and deployment variables.
- Contract and remove Claude-specific database fields.

Exit criterion: no production Claude traffic remains and rollback is formally
closed.

## 19. Test Plan

### 19.1 Unit tests

- Every Codex event-to-platform event mapping.
- Delta ordering and deduplication.
- Unknown item handling.
- Error mapping.
- Config TOML generation.
- `AGENTS.md`, skill, and agent conversion.
- Model capability validation.
- Thread start/resume/fallback behavior.
- Idempotent interruption and shutdown.

### 19.2 Contract tests

Run the same runtime contract suite against Claude and Codex:

- Text-only turn.
- Multi-turn resume.
- Tool command success and failure.
- File create, edit, and delete.
- MCP tool success and failure.
- Skill activation.
- Subagent delegation.
- Timeout and cancellation.
- Client disconnect and reconnect.
- Unsupported model.
- Context-limit failure.

### 19.3 Integration tests

- Backend to local Codex runtime.
- Backend to Bedrock through Codex.
- AgentCore invocation.
- S3 download, mutation, diff, and upload.
- PostgreSQL thread persistence.
- Redis stream reconnection.
- Frontend rendering of translated events.

### 19.4 Security tests

- Path traversal.
- Symlink escape.
- Reads outside workspace.
- Writes to documents.
- Blocked commands.
- Unauthorized MCP server access.
- Cross-tenant thread and workspace access.
- Forged approval response.
- Secret redaction in errors and logs.

### 19.5 Performance tests

Measure:

- Runtime cold start.
- Time to first text event.
- Total turn latency.
- Memory and CPU per active turn.
- Maximum stable concurrency.
- Event backlog behavior.
- S3 synchronization duration.

## 20. Rollout and Rollback

Rollout controls:

- Global runtime default.
- Organization allowlist.
- Session-level forced runtime for testing.
- Percentage canary.
- Model/provider capability gate.

Rollback must:

- Route new turns to Claude.
- Keep platform chat history intact.
- Ignore Codex thread IDs when Claude is selected.
- Avoid destructive database downgrades.
- Preserve both workspace layouts until the stabilization window closes.

Do not remove Claude dependencies or columns before rollback is closed.

## 21. Acceptance Criteria

The migration is complete when:

- Codex is selectable through configuration without changing chat routes.
- New and resumed conversations work.
- Existing conversations continue through bounded history on first Codex use.
- SSE text, tool, result, heartbeat, error, and preview behavior remains
  compatible.
- Cancellation, timeout, reconnect, and graceful shutdown pass.
- Skills, subagents, MCP servers, documents, memories, and generated
  applications pass integration tests.
- AgentCore execution and S3 carry-forward pass.
- Tenant isolation and security tests pass.
- Only supported runtime/model combinations are selectable.
- Production SLOs meet or exceed the approved thresholds.
- Rollback has been tested.
- Claude-specific code is removed only after the stabilization window.

## 22. Known Product Differences

- Codex SDK is documented for coding-focused threads. Super Agent includes
  broader business workflows; those workflows require explicit quality
  evaluation.
- Codex project files and plugins are not Claude-compatible.
- Codex uses typed command, file, MCP, and collaboration items rather than
  Claude content blocks.
- Codex has native sandbox and structured approval capabilities.
- Codex can emit native plans and diffs.
- Codex Bedrock support targets supported OpenAI model IDs, not every model
  currently accepted by the platform's Anthropic compatibility proxy.
- Token usage may be available without a directly comparable USD cost field.

## 23. Open Decisions

These decisions must be resolved before Phase 4:

1. Whether the compatibility frontend will ignore Codex-native plan and diff
   events or expose them.
2. Whether approvals remain server-policy-driven or become interactive.
3. Which current plugins are required for launch.
4. Which Bedrock OpenAI models and regions are approved.
5. The maximum replay history and token budget after resume failure.
6. Whether noncoding business scopes meet quality requirements with Codex or
   should use a broader orchestration runtime.
7. Whether runtime selection is organization-wide or per scope.
8. The stabilization and rollback-window duration.

## 24. Required Documentation Updates

Before rollout, update:

- Deployment and infrastructure guides.
- Environment variable reference.
- Runtime architecture diagrams.
- Model-provider setup.
- Workspace file conventions.
- Skill and subagent authoring guidance.
- Plugin compatibility guidance.
- Operational runbooks.
- Incident rollback procedure.

## 25. Implementation Audit

This section is the source-of-truth audit of the current repository. A feature
is not considered migrated merely because Codex has a similar capability. It
must pass through the existing platform contract and its current caller must
have an executable test.

### 25.1 Runtime behavior that must be preserved

`backend/src/services/claude-agent.service.ts` currently provides all of the
following:

- Lazy SDK loading.
- A bounded concurrency queue.
- Per-session abort controllers.
- Idle timeout reset on every yielded event.
- New session and resumed session execution.
- Per-invocation model/provider/environment selection.
- Bedrock and Anthropic-compatible gateway routing.
- Project workspace, plugins, MCP servers, and allowed-tool configuration.
- Security hooks for command policy, path escape, binary reads, and allowed
  skill access.
- Translation into `session_start`, `assistant`, `result`, and `error`.
- Text, `tool_use`, and `tool_result` content blocks.
- Graceful disconnect of one or all active sessions.

`CodexAgentRuntime` must implement those platform behaviors even when the
native mechanism differs. Queueing, timeout, and abort behavior remain backend
responsibilities; they are not delegated implicitly to app-server.

### 25.2 All runtime consumers

The contract suite must cover every direct `AgentRuntime.runConversation()`
caller:

| Caller | Current output dependency | Codex requirement |
| --- | --- | --- |
| `chat.service.ts` streaming | All event types, tool IDs, session ID, model, token usage | Full app-server adapter |
| `chat.service.ts` non-SSE/IM | Accumulated assistant blocks and persisted JSON | Same normalized blocks as streaming |
| `workflow-generator.service.ts` | Text blocks containing JSON or clarification | Preserve ordered text and terminal errors |
| `workflow-orchestrator.ts` | Assistant/result text | Preserve final text extraction |
| `workflow-executor-v2.ts` | Text markers, progress MCP callbacks, token usage | Replace in-process MCP and retain marker fallback |
| `scope-generator.service.ts` | Written JSON file, tool input fallback, repair turns | File correctness plus bounded same-thread repair |
| `skill-scanning.service.ts` | Written JSON file and Write-tool input fallback | File correctness plus normalized file-change input |
| `node-executors/agent-executor.ts` | Text, tool-use summary, provider session ID | Provider-neutral field names and no silent fallback |
| Chat room workspace setup | Hard-coded `ClaudeAgentRuntime` construction | Resolve selected runtime through the factory |

The deprecated `backend/src/services/agentcore.service.ts` must be classified
and either removed or tested. It must not remain as a second, divergent
AgentCore protocol implementation.

### 25.3 Existing non-runtime behavior coupled to Claude

The following are also in migration scope:

- `workspace-manager.ts`: every generated path and every workspace skill,
  agent, MCP, plugin, S3, read, write, install, and delete operation.
- `carry-forward.service.ts`: skills, agents, custom instructions, scope system
  prompt, MCP settings, hooks, hashing, version bump, and per-scope locking.
- `workshop.service.ts`: discovery of newly generated skills.
- `conversation-hooks.ts`: subagent and skill metrics.
- `langfuse.service.ts`: tool call/result correlation.
- `output-sanitizer.ts`: all event, input, result, error, approval, path, and
  secret payloads.
- `chat.repository.ts` and Prisma: provider thread persistence.
- `WorkspaceExplorer.tsx`: Codex TOML agent recognition and display.
- `SkillsPanel.tsx`: runtime-neutral skill paths.
- `PluginsPanel.tsx`: no promise that a Claude plugin runs unchanged.
- Chat routes that directly manipulate `.claude/settings.json`,
  `.claude/skills`, or AgentCore container paths.
- Skill marketplace routes that write `.claude/skills` directly.
- Deployment scripts, user-data, Docker image, IAM, environment generation,
  health checks, and operational documentation.

## 26. Feature Parity Matrix

Status values used below:

- `DESIGN`: specified but not implemented.
- `BLOCKED`: requires a product, infrastructure, or compatibility decision.
- `VALIDATE`: mechanism is documented but must be proven in this deployment.
- `UNSUPPORTED`: must be disabled or replaced; silent fallback is forbidden.

| Feature | Current Claude implementation | Codex implementation | Verification | Status |
| --- | --- | --- | --- | --- |
| New conversation | `query()` yields a Claude session ID | `thread/start`, persist returned thread ID | Two-turn contract test | DESIGN |
| Resume | Claude `resume`; AgentCore uses injected history | `thread/resume`; bounded platform-history replacement on missing state | Kill process, restart, resume | DESIGN |
| Thread ownership | One Claude query lifecycle per invocation | One app-server owner and subscription per loaded thread | Duplicate-owner rejection test | DESIGN |
| Streaming text | Claude assistant text blocks | `item/agentMessage/delta` plus completed item reconciliation | Delta ordering/dedup test | DESIGN |
| Final result | Claude `result` message | `turn/completed` plus final completed agent message | Exactly one result event | DESIGN |
| Token usage | Claude result usage | `thread/tokenUsage/updated`; terminal snapshot when available | Counter mapping test | VALIDATE |
| Cost | Claude result may expose cost | No assumed directly comparable field | Assert absent, never zero-filled | DESIGN |
| Command tools | `Bash` tool blocks and hooks | Command execution items and hooks | Success, nonzero exit, timeout | DESIGN |
| File edits | `Write`/`Edit` tool blocks | File-change items and `apply_patch` hooks | Create/edit/delete/binary test | DESIGN |
| Web tools | `WebSearch`/`WebFetch` | Codex web item types when enabled | Capability-gated integration test | VALIDATE |
| MCP stdio | SDK MCP config | `[mcp_servers.<name>] command/args/env` | Startup and call test | DESIGN |
| MCP HTTP | SSE/HTTP SDK config | Streamable HTTP `url` and auth fields | Authenticated call test | DESIGN |
| Legacy MCP SSE | Claude SDK accepts SSE | No assumption of direct parity | Bridge to streamable HTTP or disable | BLOCKED |
| In-process MCP | `createSdkMcpServer()` object | Stable local stdio/HTTP bridge; experimental dynamic tools only as optional path | Workflow progress test local and AgentCore | DESIGN |
| Skills | Claude `Skill` tool and `.claude/skills` | `.agents/skills`, explicit skill input, or implicit activation | Discovery and execution test | DESIGN |
| Skill telemetry | Detect tool name `Skill` | Record explicit skill input and native skill/tool evidence; otherwise label inferred | Metrics correctness test | DESIGN |
| Subagents | Claude `Task` tool | Codex collaboration/subagent items and agent threads | Speaker/status lifecycle test | DESIGN |
| Custom agents | `.claude/agents/*.md` | `.codex/agents/*.toml` with required fields | Parse and spawn each agent | DESIGN |
| Mention routing | Prompt forces `Task` with a subagent name | Resolve DB agent to Codex custom-agent name and require delegation | Mentioned-agent E2E test | DESIGN |
| Plugins | Clone into `.claude/plugins` | Convert to Codex plugin, skill, MCP, or hook | Per-plugin compatibility manifest | BLOCKED |
| Instructions | Generated `CLAUDE.md` | Generated `AGENTS.md` | Golden content test | DESIGN |
| Project config | `.claude/settings.json` | Project `.codex/config.toml` for allowed project keys | Config load test | DESIGN |
| Provider config | Invocation env and Claude options | Isolated `$CODEX_HOME/config.toml` or supported runtime overrides | Assert effective provider | DESIGN |
| Model switching | Reset Claude session when model changes | Turn override if supported; otherwise new thread plus bounded replay | Same-thread and replacement tests | VALIDATE |
| Images | Paths persisted as message metadata; not added to current agent prompt | Send `image`/`localImage` turn inputs after validating model input modality | PNG/JPEG multi-turn test | DESIGN |
| Uploaded files | Prompt lists workspace filenames | Keep file context and workspace access | PDF/DOCX/text tests | DESIGN |
| Interactive approvals | Claude bypass plus custom hooks | App-server approval server requests and authenticated response API | Approve/deny/expire/forge tests | BLOCKED |
| Background approvals | Claude bypass plus blockers | `approval_policy = "never"` with sandbox and hooks; denied actions fail | Denied-action test | DESIGN |
| Sandbox | Prompt restrictions plus hooks | `workspaceWrite`, explicit writable roots, restricted network | Escape and network tests | DESIGN |
| Client disconnect | Server continues; stream registry reconnects | Keep active turn and app-server subscription alive | Disconnect/reconnect E2E | DESIGN |
| User stop | Frontend currently aborts fetch only | New server stop endpoint calls `turn/interrupt` | Interrupted terminal status test | DESIGN |
| Runtime timeout | Backend timer disconnects provider session | Timer calls `turn/interrupt`, then force-kills hung process after grace period | Timeout cleanup test | DESIGN |
| Graceful shutdown | Disconnect all Claude sessions | Interrupt turns, close subscriptions, terminate child processes | SIGTERM integration test | DESIGN |
| Output sanitization | Claude block-aware sanitizer | Native Codex item sanitizer before legacy conversion and persistence | Secret/path fixture tests | DESIGN |
| Langfuse | Claude tool IDs pair spans | Native item ID pairs start/completion; collaboration is not flattened internally | Trace shape test | DESIGN |
| AgentCore restore | S3 to `/workspace` | Same behavior with runtime-neutral layout | Restore test | DESIGN |
| AgentCore sync | Write/Edit incremental; Stop full sync, currently async | Optional incremental plus awaited full reconciliation including deletions | Create/edit/delete then immediate read | DESIGN |
| AgentCore cancellation | Backend implementation is a no-op | Abort invocation stream and interrupt/terminate in-container turn where supported | Stop remote turn test | BLOCKED |
| AgentCore continuity | Bounded DB history injection | Attempt Codex resume, retain bounded history fallback | Recycled microVM test | DESIGN |
| AgentCore telemetry | Hand-built Claude instrumentation scope/provider | Codex-specific validated scope or replacement evaluator pipeline | AWS Evaluate acceptance test | BLOCKED |
| Bedrock models | Arbitrary catalog through direct/proxy routes | Exact Codex-supported OpenAI model IDs only | Startup capability probe | DESIGN |
| LiteLLM models | Anthropic-compatible remapping | Invocation-level Claude adapter routing with isolated config and canonical Codex workspace | Live catalog, native Claude resume, Claude-to-Codex switch | VALIDATED |
| AgentCore browser/code interpreter | Injected MCP server | Share a constrained dedicated-resource proxy across Codex/AgentCore and LiteLLM Claude runtimes | Codex and Claude Browser/Code Interpreter E2E tests | VALIDATED |
| Memory/documents/apps | Workspace conventions and prompts | Same business behavior through layout abstraction | Domain E2E suite | DESIGN |
| Carry-forward | Reads Claude paths and formats | Read selected runtime layout; parse TOML agents/config/hooks | Round-trip and conflict tests | DESIGN |

## 27. Native Event Model and Compatibility Boundary

### 27.1 Internal event model

Do not use Claude content blocks as the internal Codex representation. Add a
provider-neutral native event union:

```ts
type RuntimeItem =
  | { kind: 'message'; id: string; text: string; phase: 'delta' | 'completed' }
  | { kind: 'command'; id: string; command: string; status: string; output?: string }
  | { kind: 'file_change'; id: string; changes: unknown; status: string }
  | { kind: 'mcp_call'; id: string; server: string; tool: string; status: string; result?: unknown }
  | { kind: 'collaboration'; id: string; agentId?: string; agentType?: string; status: string }
  | { kind: 'approval'; id: string; approvalType: string; request: unknown }
  | { kind: 'plan'; turnId: string; plan: Array<{ step: string; status: string }> }
  | { kind: 'diff'; turnId: string; diff: string }
  | { kind: 'usage'; threadId: string; usage: RuntimeTokenUsage }
  | { kind: 'warning'; message: string }
  | { kind: 'error'; code: string; message: string; details?: unknown };
```

The adapter pipeline is:

```text
app-server JSON-RPC
  -> schema-versioned decoder
  -> sanitized RuntimeItem
  -> telemetry/persistence/subagent state
  -> legacy ConversationEvent adapter
  -> existing SSE writer
```

This prevents new native item types from being misrepresented as fictional
Claude tools.

### 27.2 App-server lifecycle

The production client must:

1. Spawn the pinned Codex app-server with `stdio`.
2. Send `initialize`, then `initialized`, once per connection.
3. Generate TypeScript or JSON schemas from the pinned Codex binary during
   build or CI and compile the decoder against those artifacts.
4. Use `thread/start` or `thread/resume`.
5. Start one turn and subscribe to its thread notifications.
6. Correlate every notification by thread, turn, and item ID.
7. Treat `item/completed` as authoritative while deduplicating emitted deltas.
8. Finish only on `turn/completed`, including `interrupted` and `failed`.
9. Unsubscribe/unload idle threads and reap dead child processes.
10. Reject malformed, cross-thread, duplicate-terminal, or post-terminal
    events.

### 27.3 Legacy SSE mapping

Compatibility mapping must follow these rules:

- Emit `session_start` once after thread start/resume succeeds.
- Emit text deltas as ordered `assistant` text blocks.
- Convert command, file, and MCP starts to `tool_use` only at this edge.
- Convert their completion to `tool_result` using the same native item ID.
- Do not emit a second copy when both delta and completed events contain text.
- Keep plan and diff as optional provider-neutral fields; do not insert them
  into assistant prose.
- Use collaboration item metadata for speaker identity and busy/active state.
- Emit one terminal `result` for completed/interrupted turns.
- Emit stable `error` codes for failed turns and process failures.
- Never forward reasoning payloads, raw approval secrets, environment values,
  or unsanitized upstream details.

### 27.4 App-server process ownership

Choose and document one of these before implementation:

- A worker-local app-server process pool with sticky thread ownership.
- One isolated app-server process per active platform session.

The first is more efficient; the second has simpler tenant isolation. In both
cases, a process crash must invalidate its loaded-thread map, attempt
`thread/resume` in a replacement process, and use bounded replay only if resume
fails. A database thread ID does not prove that the current process has the
thread loaded.

## 28. Workspace and Configuration Contract

### 28.1 Layout abstraction

Introduce:

```ts
interface RuntimeWorkspaceLayout {
  instructionsFile: string;
  skillsDir: string;
  agentsDir: string;
  configFile: string;
  hooksFile?: string;
  pluginsDir?: string;
  scopePromptFile: string;
}
```

Every route and service must request paths from this abstraction. No new
business logic may concatenate `.claude` or `.codex` paths directly.

During dual runtime:

- Database records are canonical.
- Claude and Codex trees are generated independently.
- S3 may retain the existing session prefix, but runtime-owned subpaths come
  from the selected layout.
- Workspace file APIs may expose both trees, but mutation APIs must target the
  selected runtime explicitly.
- A config-version refresh regenerates both layouts without deleting
  user-authored compatible content.

### 28.2 Skills

For each skill source type already supported, preserve:

- S3 ZIP extraction with traversal protection.
- Local directory copy.
- Generated `SKILL.md` body.
- Description-only fallback generation.
- Supporting scripts, references, and assets.
- Symlinks only when the resolved target remains inside an allowed root.
- Content hash and version bump behavior.

Skill telemetry must have three confidence levels:

- `explicit`: a `skill` input item was sent.
- `observed`: a native item or hook identifies the skill.
- `inferred`: prompt/path evidence only.

Do not increment the current exact-use metric from inferred activation unless
the metric name is changed.

### 28.3 Custom agents and collaboration

Convert DB agents directly to TOML; do not parse generated Claude Markdown.
Validate `name`, `description`, and `developer_instructions` before making the
agent selectable.

Maintain mappings:

```text
DB agent ID <-> technical agent name <-> Codex agent type/file
native subagent thread ID <-> platform speaker metadata
```

The frontend's agent-file detector must accept `.codex/agents/*.toml`.
Subagent state must close on completion, failure, interruption, process crash,
or parent-turn termination.

### 28.4 MCP conversion

Normalize MCP records before rendering either provider format:

```ts
type NormalizedMcpServer =
  | { transport: 'stdio'; command: string; args: string[]; envRefs: Record<string, string> }
  | { transport: 'streamable_http'; url: string; bearerTokenEnvVar?: string; headers?: Record<string, string> };
```

Migration rules:

- Convert supported Claude HTTP records to Codex streamable HTTP.
- Treat legacy SSE-only endpoints as incompatible until bridged.
- Never serialize an in-memory JavaScript server object into AgentCore payloads.
- Replace workflow-progress with a small stdio or streamable-HTTP MCP bridge
  reachable in both local and AgentCore execution.
- Experimental app-server dynamic tools may be prototyped, but are not the
  launch dependency.
- Mark required MCP servers with startup failure semantics; optional servers
  may degrade with a visible warning.
- Preserve startup timeout, tool timeout, allow/deny lists, credentials, and
  tenant authorization.

### 28.5 Hooks and security

Codex hooks cover `PreToolUse`, `PermissionRequest`, `PostToolUse`,
`SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`,
`UserPromptSubmit`, `Stop`, and compaction events. Port current policy into
versioned hook executables or inline hook configuration.

Required security equivalence:

- Dangerous command matching.
- Workspace path normalization.
- Symlink escape detection.
- Binary read restrictions.
- Allowed-skill restrictions.
- Secret and internal-token redaction.
- Network destination policy.
- Tenant-specific MCP authorization.

`PostToolUse` cannot undo a side effect. Any preventive rule must run in the
sandbox, `PreToolUse`, `PermissionRequest`, or an external policy layer.

### 28.6 Plugins

Create a persisted plugin compatibility report:

```ts
interface PluginMigrationResult {
  pluginId: string;
  classification: 'skills' | 'mcp' | 'hooks' | 'codex_plugin' | 'unsupported';
  convertedArtifacts: string[];
  blockers: string[];
  enabledForCodex: boolean;
}
```

Codex plugin app-server methods currently documented as under development are
not a production control plane for this migration. Use generated local
configuration and an explicit compatibility manifest until those APIs are
production-supported and contract-tested.

## 29. AgentCore Contract

### 29.1 Invocation protocol

Keep `/invocations` and `/ping`, but version the payload and event stream:

```ts
interface AgentCoreInvocationV2 {
  protocol_version: 2;
  runtime: 'codex';
  platform_session_id: string;
  provider_thread_id?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  workspace_s3_bucket: string;
  workspace_s3_prefix: string;
  model: string;
  provider: 'amazon-bedrock' | 'openai';
}
```

Do not send raw API keys in the JSON payload when AgentCore secret injection or
the AWS credential chain can supply them.

### 29.2 Container changes

The Codex image must:

- Pin the Codex CLI/runtime and SDK versions together.
- Remove `@anthropic-ai/claude-code`,
  `@anthropic-ai/claude-agent-sdk`, `CLAUDE_CODE_*`, and `ANTHROPIC_*`.
- Create a writable, invocation-safe `CODEX_HOME`.
- Put provider/auth/telemetry settings in `$CODEX_HOME/config.toml`.
- Put project instructions, skills, custom agents, hooks, and project-safe
  config under `/workspace`.
- Start app-server locally over stdio.
- Preserve `uv/uvx` and the AgentCore browser/code-interpreter MCP dependency.
- Run as non-root and keep `/workspace` as the only business writable root.

If a warm container serves more than one tenant, `CODEX_HOME`, thread storage,
MCP credentials, and environment mutation must be isolated per invocation.
The current process-global mutation of `API_BASE_URL` and `AUTH_TOKEN` is not
safe under concurrent cross-tenant invocations.

### 29.3 Workspace synchronization

The final sync protocol must be explicit:

1. Restore S3 prefix to an empty or reconciled workspace.
2. Create a Git baseline.
3. Run the turn.
4. Interrupt or complete the turn.
5. Reconcile local files to S3, including deletions.
6. Upload `__diff__.json`.
7. Emit `workspace_sync_completed` with counts and checksum/version.
8. Only then emit the terminal invocation event or a terminal sync error.
9. Backend syncs local cache and starts carry-forward.

Carry-forward treats organization-level or other-scope skills as immutable
conflicts and skips them. Existing scope-owned skills are written back to the
`s3_bucket` recorded on their database row, never to an unrelated process
default. This prevents a missing default bucket from turning a successful Chat
turn into a false terminal failure.

Upload-only traversal leaves deleted S3 objects behind. The sync
implementation must compare the final local manifest with the remote manifest
and issue `DeleteObject` for stale keys, excluding protected metadata.

### 29.4 Cancellation

`AgentCoreAgentRuntime.disconnectSession()` is currently a no-op. Codex launch
is blocked until remote cancellation has a proven behavior:

- Abort the AWS response stream.
- Signal the in-container active turn to `turn/interrupt` when the protocol
  permits it.
- Force-terminate the child app-server after a bounded grace period.
- Ensure final sync runs against the interrupted state or explicitly reports
  that it did not.
- Release runtime/session tracking idempotently.

### 29.5 Observability and AWS Evaluate

The current implementation hard-codes:

```text
instrumentation scope = openinference.instrumentation.claude_agent_sdk
provider = anthropic
```

Neither value is valid to retain for a Codex runtime. Before rollout:

1. Emit Codex/OpenAI provider attributes truthfully.
2. Preserve platform session, provider thread, turn, and tool item IDs.
3. Verify the exact instrumentation scope accepted by AgentCore Evaluate.
4. Run all configured evaluators against a Codex session.
5. If AWS Evaluate rejects the Codex scope, build a separate evaluation export
   or disable the unsupported evaluators visibly.

Do not label Codex spans as Claude merely to pass an allowlist.

## 30. Persistence and API Changes

### 30.1 Database rollout

Use an expand migration:

```text
chat_sessions.provider_runtime
chat_sessions.provider_thread_id
chat_sessions.provider_thread_model
chat_sessions.provider_thread_metadata
```

Add an index appropriate for provider/thread lookup and a constraint preventing
one provider's thread ID from being resumed under another provider.

Repository methods become:

```ts
updateProviderThread(
  sessionId,
  organizationId,
  runtime,
  threadId,
  model,
  metadata,
): Promise<void>
```

All reads and writes remain organization-scoped.

### 30.2 Chat API

Keep the existing stream endpoint, then add:

```text
POST /api/chat/sessions/:sessionId/stop
```

The endpoint must:

- Authenticate the user.
- Verify organization/session ownership.
- Interrupt only the active turn for that platform session.
- Return idempotent success when no turn is active.
- Emit an interrupted terminal event to the stream registry.
- Audit the actor and provider turn ID.

The existing frontend `AbortController` remains a detach operation unless it
also calls this endpoint.

### 30.3 Images

`attached_images` is currently persisted as metadata but is not inserted into
the runtime message. Implement:

- Canonical workspace or signed-source resolution.
- MIME and size validation.
- Tenant/path authorization.
- Codex `image` or `localImage` turn input construction.
- Model capability validation through `model/list` input modalities.
- Sanitized persistence that does not rely on expiring blob URLs.

If the selected model does not accept images, reject with
`AGENT_IMAGE_UNSUPPORTED`; do not silently send only the text.

### 30.4 No silent fallback

The following current or tempting fallbacks are forbidden for Codex:

- Codex failure to direct Bedrock without skills/workspace.
- Unsupported Codex model to a different model without an explicit reroute
  event and policy.
- Failed subagent delegation to a direct main-agent answer when an explicit
  mention required delegation.
- Missing workflow progress MCP to success without marker validation.
- Failed file output to unvalidated prose when a machine-readable artifact is
  required.
- Unsupported plugin or MCP transport to omission without a user-visible
  compatibility result.
- Failed image input to text-only execution.
- Failed resume to unbounded replay.
- Missing token/cost data to fabricated zero values.

`node-executors/agent-executor.ts` currently falls back from the agent runtime
to direct Bedrock. Make that fallback an explicit workflow policy flag and
default it off for Codex parity tests.

## 31. Module-by-Module Change List

### Backend runtime

- `agent-runtime.ts`: move shared types out of the Claude service; add
  provider-neutral thread/turn fields and native items.
- `agent-runtime-factory.ts`: add `codex`; reject unknown runtime values rather
  than silently selecting Claude.
- `agent-runtime-codex.ts`: lifecycle, queue, timeout, active turns, and runtime
  contract.
- `codex-app-server-client.ts`: stdio JSON-RPC, initialize handshake, schema
  validation, correlation, interruption, process recovery.
- `codex-event-adapter.ts`: native items and legacy SSE conversion.
- `claude-agent.service.ts`: remain unchanged except shared-type extraction
  during dual operation.

### Backend consumers

- `chat.service.ts`: provider-neutral persistence, collaboration identity,
  explicit skill telemetry, image inputs, runtime-specific timeout config.
- `workflow-progress-mcp.ts`: replace Anthropic SDK server helpers with a
  provider-neutral MCP bridge.
- `workflow-executor-v2.ts`: write `AGENTS.md` through layout API, support the
  new progress bridge, interrupt on timeout.
- `scope-generator.service.ts`: provider thread field, file-change fallback,
  repair-turn continuity, runtime-neutral copy.
- `skill-scanning.service.ts`: normalized file output/tool evidence.
- `workflow-generator.service.ts`, `workflow-orchestrator.ts`: contract tests
  for ordered and final text.
- `node-executors/agent-executor.ts`: rename Claude fields and gate direct
  Bedrock fallback.
- `chatRooms.routes.ts`: stop constructing `ClaudeAgentRuntime` directly.

### Workspace and persistence

- `workspace-manager.ts`: runtime-specific canonical layout, verified legacy
  migration, manifest layout versioning, and inactive-layout removal.
- `scripts/migrate-workspaces-to-codex.ts`: repeatable local/S3 migration for
  existing session workspaces.
- `carry-forward.service.ts`: layout-aware readers and TOML parsing.
- `workshop.service.ts`: scan root plus selected runtime skill directory.
- `chat.repository.ts`: provider-neutral update method.
- `schema.prisma`: expand fields and later contract migration.
- `model-resolver.ts`: Codex capability table and exact provider/model gate.
- `config/index.ts`: independent `config.codex`, validated runtime enum.

### Telemetry and security

- `conversation-hooks.ts`: native collaboration and skill evidence.
- `langfuse.service.ts`: native item spans and IDs.
- `output-sanitizer.ts`: exhaustive Codex item and server-request cases.
- `claude-hooks.ts`: extract policy core, then add Codex hook adapters.
- `token-usage.service.ts`: optional counters and no assumed cost.

### Routes and frontend

- `chat.routes.ts`: provider-neutral types, stop endpoint, layout-aware
  workspace/MCP/skill operations.
- `skill-marketplace.routes.ts`: layout-aware container and S3 writes.
- `mcp-server.routes.ts`: normalized transport schema.
- `WorkspaceExplorer.tsx`: `.toml` agent files and real `AGENTS.md` names.
- `SkillsPanel.tsx`: runtime-neutral locations.
- `PluginsPanel.tsx`: compatibility status and disabled reasons.
- `chatStreamService.ts`, `SessionStreamManager.ts`, `ChatContext.tsx`: separate
  detach from explicit stop.
- Model settings UI: filter by runtime/provider/model/input modality.

### AgentCore and infrastructure

- `agentcore/Dockerfile`: pinned Codex runtime, isolated `CODEX_HOME`, remove
  Claude dependencies and variables.
- `agentcore/src/agent-runner.ts`: app-server client and event adapter.
- `agentcore/src/index.ts`: versioned protocol, cancellation channel, awaited
  final sync.
- `agentcore/src/workspace-sync.ts`: runtime-neutral paths and deletion
  reconciliation.
- `agentcore/src/otel.ts`: truthful provider/scope and validated Evaluate
  contract.
- `infra/scripts/deploy*.sh`, `user-data.sh`, CI env generation, CDK task
  environment, and README: replace Claude defaults, add Codex health probes,
  preserve IAM for Bedrock and AgentCore tools.

## 32. Release Gates

Codex must not become the default until every gate below is green.

Audit status on 2026-08-14:

| Gate | Status | Evidence / remaining condition |
| --- | --- | --- |
| A: Protocol | GREEN | Pinned schema, unknown/server-request handling, start/resume/interrupt/recovery, ownership, and terminal uniqueness passed. |
| B: User-visible chat | GREEN | Text, coalesced streaming deltas, tools, errors, stop, persistence, images, mention/subagent, Codex Browser, and LiteLLM Claude Browser validation passed. |
| C: Workspaces | GREEN | Codex-only layout, migration, carry-forward round-trip, MCP/hooks/skills/agents, sync, and explicit unsupported plugin status passed. |
| D: Non-chat consumers | CONDITIONAL | Workflow, scope, twin, skill scan, node execution, and IM contracts passed. External Slack delivery awaits valid credentials for the existing test fixtures. No enabled A2A peer exists. |
| E: Security | GREEN | Sandbox, network, path/symlink, approval, secret, synchronization, and warm-container isolation tests passed locally and on Runtime C. |
| F: AgentCore | GREEN WITH EXCLUSION | Model/Region, dedicated Browser/Code Interpreter enforcement for both Codex and LiteLLM Claude, cancellation, S3/diff/carry-forward ordering passed. AWS Evaluate remains excluded from the launch SLO until separately validated. |
| G: Rollout | DEPLOYED / OPEN | A new isolated `us-east-1` ECS stack and create-only AgentCore Runtime passed direct and full-platform E2E. Production shadow comparison, canary observation, SLO acceptance, hardening decisions, and rollback exercise remain required. |

### Gate A: Protocol

- Pinned app-server schema is generated and checked in or generated in CI.
- Unknown item fixtures fail safely.
- Start, resume, interrupt, crash recovery, and terminal-event uniqueness pass.
- Process/thread ownership survives backend worker restart.

### Gate B: User-visible chat

- Text, tools, errors, heartbeat, reconnect, model display, and persistence pass
  against the current frontend.
- Browser detach continues the turn.
- Explicit stop interrupts the server turn.
- Mention routing and subagent speaker state pass.
- Image inputs either work end-to-end or are capability-rejected.

### Gate C: Workspaces

- Instructions, skills, agents, MCP, hooks, memory, documents, and generated
  apps work from a clean workspace.
- Carry-forward round-trips every supported artifact.
- Workspace APIs and marketplace operations use the selected runtime layout.
- Every enabled plugin has a compatibility result.

### Gate D: Non-chat consumers

- Workflow generation and patch generation produce valid JSON.
- Workflow execution reports each step exactly once.
- Scope generation, repair, and digital twin generation produce valid config.
- Skill scanning produces and validates `scan-results.json`.
- Node agent execution preserves tools and errors without implicit fallback.
- Slack/Discord/WeCom/Feishu or other enabled IM adapters receive complete text.

### Gate E: Security

- Sandbox, hooks, path traversal, symlink, binary, command, network, MCP,
  cross-tenant, approval forgery, and secret-redaction tests pass.
- No provider/auth/telemetry secrets are written into project configuration.
- Warm AgentCore concurrency cannot leak `CODEX_HOME`, environment, thread, or
  workspace state between tenants.

### Gate F: AgentCore

- Supported Bedrock OpenAI model and Region are validated.
- Browser and code-interpreter MCP calls pass.
- Cancellation works or Codex AgentCore rollout remains disabled.
- Final S3 sync, deletion, diff, and carry-forward are acknowledged before
  completion.
- AWS traces are truthful and configured evaluators accept Codex telemetry, or
  unsupported evaluation is explicitly removed from the launch SLO.

### Gate G: Rollout

- Shadow comparison covers representative business and coding scopes.
- Canary error rate, first-token latency, completion latency, tool success,
  valid-artifact rate, and token usage meet agreed thresholds.
- Runtime/model capability failures occur before a turn starts.
- Rollback to Claude is exercised without database or workspace loss.

## 33. Official References

- Codex SDK: <https://learn.chatgpt.com/docs/codex-sdk>
- Codex app-server: <https://learn.chatgpt.com/docs/app-server>
- Codex configuration: <https://learn.chatgpt.com/docs/config-file/config-reference>
- `AGENTS.md`: <https://learn.chatgpt.com/docs/agent-configuration/agents-md>
- Codex skills: <https://learn.chatgpt.com/docs/skills>
- Codex hooks: <https://learn.chatgpt.com/docs/config-file/config-advanced#hooks>
- Codex on Amazon Bedrock:
  <https://learn.chatgpt.com/docs/amazon-bedrock>
