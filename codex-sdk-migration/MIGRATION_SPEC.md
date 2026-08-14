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

The Claude runtime remains available during validation and rollback. Existing
deployed AgentCore Runtimes must not be updated or deleted by this migration.

### 1.1 Implementation record

As of 2026-08-14:

- Provider-neutral runtime and event contracts are implemented.
- Local `CodexAgentRuntime` starts the pinned Codex CLI app-server over JSONL
  stdio and supports start, resume, bounded history replay, cancellation,
  images, MCP, hooks, collaboration events, plans, diffs, and token usage.
- Workspaces now use one runtime-native layout. Codex and AgentCore generate
  only `AGENTS.md`, `.agents/skills/*`, `.codex/*`, and provider-neutral
  `.runtime/*`; they no longer emit `CLAUDE.md` or `.claude/*`.
- Legacy Claude workspaces are migrated lazily and through the repeatable
  `npm run workspace:migrate:codex` command. The migration merges missing
  skills, converts Markdown agent definitions to TOML, migrates MCP config,
  verifies Codex counterparts, and only then removes the inactive layout.
- AgentCore now runs Codex app-server instead of the Claude Agent SDK.
- AgentCore workspace restore and final sync are awaited and reconcile S3
  deletions.
- The frontend supports image-only submissions, provider-side stop, and
  runtime-compatible model filtering.
- A real local app-server E2E against Amazon Bedrock passed with model
  `openai.gpt-5.4` and response `CODEX_E2E_OK`.
- `openai.gpt-oss-*-1:0` is intentionally rejected for this path. Those model
  IDs use Bedrock Invoke/Converse APIs, while Codex's built-in Bedrock provider
  requires the OpenAI Responses-compatible `/openai/v1/responses` model path.
- Full backend, frontend, and AgentCore production builds pass.
- Full automated test suites pass: backend `485/485`, frontend `599/599`, and
  AgentCore `5/5`.
- Browser validation passes against the locally running frontend and backend:
  authentication, runtime-compatible model selection, chat submission,
  streamed Codex rendering, responsive layout, and zero browser console,
  page, or request errors.
- Route-level frontend splitting reduced the initial JavaScript entry from
  approximately 2.9 MB to 39 KB and the Chat route from approximately 1.05 MB
  to 168 KB, with no production chunk-size warning.
- `infra/scripts/deploy-codex-agentcore-new.sh` creates only a new Runtime,
  dedicated IAM role, immutable ECR tag, and dedicated ECR repository. It has
  no update/delete path and does not modify backend runtime configuration.
- The final isolated Runtime
  `SuperAgentCodexUSEast1Validation20260814-7F4o2oHLij` in `us-east-1`
  reached `READY` and passed
  the remote Codex, tool execution, SSE, S3 mirror, and diff validation below.
- All 16 pre-existing local/S3 session workspaces were migrated to the
  Codex-only layout with zero failures. The migration preserved 53 skills,
  removed all `CLAUDE.md`/`.claude/*` keys, and stamped manifest
  `runtime=codex`, `layoutVersion=2`.
- A newly provisioned session
  `dcc1e034-f65e-404e-9a69-d7b97c72c5fc` was validated through the real
  backend-to-AgentCore path. Codex model `openai.gpt-5.4` created
  `codex-layout-proof.txt` containing `CODEX_LAYOUT_OK`; local disk, S3, and
  the workspace API exposed only the Codex layout.

### 1.2 Validation record

Final isolated AgentCore validation on 2026-08-14:

- Runtime ARN:
  `arn:aws:bedrock-agentcore:us-east-1:632930644527:runtime/SuperAgentCodexUSEast1Validation20260814-7F4o2oHLij`
- Runtime version/status: `1`, `READY`
- Immutable image:
  `632930644527.dkr.ecr.us-east-1.amazonaws.com/super-agent-agentcore-codex:codex-use1-202608140215`
- Image digest:
  `sha256:8fec0efe001db8e8bf65a433534c98bceffcf2d825f0fb9397a22d93da3c7236`
- Container: ARM64, 11 filesystem layers, numeric user `1000:1000`, pinned
  `codex-cli 0.146.0`
- Bedrock model/Region: `openai.gpt-5.4`, `us-east-1`
- Workspace bucket/Region:
  `superagentdev9-workspace-632930644527`, `us-east-1`
- Provider thread:
  `019ffe0e-43b6-7071-9c50-3ee3abf6a9d0`
- Provider turn:
  `019ffe0e-43d6-7df1-9415-4d2deb18e75c`
- Assistant assertion: `CODEX_AGENTCORE_E2E_OK`
- Workspace assertion:
  `codex-validation/use1-final-20260814/codex-agentcore-proof.txt` contained
  `CODEX_AGENTCORE_FILE_OK`
- Diff assertion:
  `codex-validation/use1-final-20260814/__diff__.json` reported one added file,
  one insertion, and a patch containing `codex-agentcore-proof.txt`
- The Runtime execution role includes `bedrock-mantle:CreateInference`, which
  is required by Codex's Bedrock OpenAI Responses path in addition to the
  legacy Bedrock invoke permissions.
- Backend runtime configuration was not changed.
- Existing `SuperAgentRuntime-CY9MAr6l5M` and
  `SuperAgentDev9Runtime-6SzVHpBKNJ` in `us-east-1` remained `READY` with their
  original versions, images, and update timestamps. No existing Runtime was
  updated or deleted.
- The earlier `us-west-2` validation remains a historical record only. The
  migration deployment and smoke-test defaults now target `us-east-1`.

Repository-wide validation completed on 2026-08-14:

- Backend: production build passed; `40` test files and `484/484` tests passed.
- Frontend: production build passed; `45` test files and `599/599` tests
  passed.
- AgentCore: production build passed; `5/5` tests passed.
- Local Codex app-server E2E passed in `us-east-1` with provider thread
  `019ffe38-0f99-7cb2-8bc1-c0c07539863f`, provider turn
  `019ffe38-0fd3-77f0-9eff-6c3402dd3145`, and response `CODEX_E2E_OK`.
- Remote AgentCore E2E passed with session
  `codex-agentcore-e2e-65f1b593-a21e-4067-a1b0-5ededc54f788`,
  provider thread `019ffe38-37ca-7b80-9408-fedcfd843cc8`, provider turn
  `019ffe38-37e7-7512-adfd-3390c875ddfc`, response
  `CODEX_AGENTCORE_E2E_OK`, and S3 proof `CODEX_AGENTCORE_FILE_OK`.
- Local browser smoke passed against `http://localhost:5173` and backend
  `http://localhost:3001`; desktop and mobile layouts had no horizontal
  overflow.
- ESLint has no blocking errors. It still reports non-blocking legacy warnings
  for broad `any` usage, missing explicit return annotations, and unused
  symbols. Those warnings are tracked as cleanup debt rather than release
  failures.

The code and functional gates are green. Codex must still pass the controlled
shadow, canary, SLO, and rollback exercises in Section 32 before it becomes the
production default.

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
- Permit per-organization and per-request runtime canaries.

## 4. Non-Goals

- Rewriting the frontend during the first compatibility phase.
- Preserving arbitrary Anthropic-protocol model compatibility.
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

### 11.4 Model picker

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

The frontend should display only combinations supported by the selected
runtime.

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
| Unsupported model/provider | `AGENT_MODEL_UNSUPPORTED` |
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
| LiteLLM arbitrary models | Anthropic-compatible remapping | Not part of initial Codex contract | Reject before turn start | UNSUPPORTED |
| AgentCore browser/code interpreter | Injected MCP server | Preserve as Codex MCP server and validate IAM | Tool E2E tests | VALIDATE |
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
