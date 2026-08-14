# Super Agent as an MCP Server — Design

Expose Super Agent to external MCP clients (Kiro, Amazon Q Developer) so a
developer can, from inside their IDE, **talk to a Super Agent and have it
complete agent work** — discover which agents/scopes exist, start a
conversation, let the agent run its full loop (skills, sub-agents, RAG, its own
MCP tools, workspace), and get the result (text + produced files) back.

> Status: design + phase-1 implementation. This document is the source of truth
> for the `/v1/mcp` endpoint.

---

## 1. Goal & non-goals

**Goal.** One thin, deep MCP surface: the IDE delegates orchestration to Super
Agent rather than driving a dozen fine-grained tools itself. The headline tool
is `chat` — everything Super Agent can do (knowledge base, workflows, skills,
sub-agents, workspace files) happens *inside* the agent run, not as separate
MCP calls.

**Non-goals (phase 1).**
- Not re-exposing all ~50 REST routes as individual MCP tools. The agent already
  orchestrates those internally; duplicating them would push orchestration back
  onto the IDE.
- Not building an AgentCore Gateway yet (see §8 — deferred phase 2).
- Not changing the existing chat/agent runtime. The MCP layer is an *adapter* in
  front of `chatService`.

---

## 2. Why this shape (key facts that drove the design)

Established by reading the backend:

- **Super Agent is currently an MCP *consumer*, not a provider.** It stores and
  connects to outbound MCP servers (`mcp_servers` table, `mcp.routes.ts`) and
  creates an in-process SDK MCP server for workflow-progress tools
  (`workflow-progress-mcp.ts`), but there is **no network-exposed MCP endpoint**
  and `@modelcontextprotocol/sdk` is **not** a dependency. So this is a net-new
  surface.
- **The "run an agent" capability is a single entry point:**
  `chatService.streamChat()` (`backend/src/services/chat.service.ts:531`), which
  starts an AgentCore microVM where the agent autonomously uses skills,
  sub-agents, RAG, workspace, and its own MCP tools. That is what we wrap.
- **Auth is already solved for external bearer clients.** The `api_keys` table +
  `apiKeyService` (SHA-256 hashed keys, scopes, per-minute rate limit, expiry)
  backs `openapi.routes.ts`, `llm-proxy.routes.ts`, `a2a.routes.ts`,
  `widget.routes.ts`. We reuse the exact `apiKeyAuth` pattern.
- **Org isolation is enforced at the service/repository layer** by passing
  `organizationId` into every call. The API key maps a bearer token →
  `organizationId`, so tenant isolation comes for free.
- **Streaming vs request/response gap.** `streamChat` writes SSE to a Fastify
  `reply`; a `streamRegistry` (`register`/`publish`/`complete`/`subscribe`/
  `isActive`) lets other consumers subscribe to an in-flight session's events.
  MCP tool calls are request/response, so the `chat` tool aggregates the stream
  (see §5).
- **Kiro and Amazon Q both support remote HTTP MCP + bearer headers** (verified):
  - Kiro `.kiro/settings/mcp.json`: remote server via `url`, bearer via
    `headers.Authorization` with `${ENV}` expansion. Native — no stdio bridge.
  - Amazon Q: remote MCP over HTTP with OAuth or open; config under
    `~/.aws/amazonq/...`.
  - Both speak **Streamable HTTP** (current MCP standard: one `/mcp` endpoint,
    POST + optional SSE), so the server must use `StreamableHTTPServerTransport`
    (not the deprecated SSE transport).

---

## 3. Architecture (phase 1: self-hosted endpoint)

```
Kiro / Amazon Q                     Super Agent backend (Fastify, ECS Fargate)
┌──────────────┐   HTTPS +bearer    ┌───────────────────────────────────────┐
│ mcp.json     │ ─────────────────► │ CloudFront  /v1/mcp/*  ─►  ALB :80     │
│  url:/v1/mcp │   Streamable HTTP  │        │                               │
│  Bearer sk_… │ ◄───────────────── │   /v1/mcp  (StreamableHTTPServerTransport)
└──────────────┘   JSON / SSE       │        │  apiKeyAuth → { organizationId }│
                                    │        ▼                               │
                                    │   McpServer  tools:                    │
                                    │   list_scopes / list_agents /          │
                                    │   chat / chat_result / get_workspace   │
                                    │        │                               │
                                    │        ▼ delegate to existing services │
                                    │   chatService.streamChat + streamRegistry
                                    │   businessScopeService / agentService  │
                                    │   workspaceManager (S3 workspace)       │
                                    └───────────────────────────────────────┘
                                              │ InvokeAgentRuntime
                                              ▼
                                     Bedrock AgentCore microVM
                                     (skills, sub-agents, RAG, workspace)
```

No new AWS resources. Reuses the existing CloudFront→ALB→Fargate path and the
`api_keys` auth boundary (same as `/v1/chat/completions`).

---

## 4. MCP tool surface

Small and deep. Discovery tools let the IDE pick a target; `chat` does the work.

| Tool | Input | Output | Backed by |
|------|-------|--------|-----------|
| `list_scopes` | — | `[{ id, name, description }]` | `businessScopeService.list(orgId)` |
| `list_agents` | `scope_id?` | `[{ id, name, display_name, role, scope_id }]` | `agentService.list(orgId, scopeId?)` |
| `chat` | `message`, `scope_id`, `agent_id?`, `session_id?` | `{ session_id, status, reply?, workspace_changes?, progress? }` | `chatService.streamChat` + `streamRegistry` |
| `chat_result` | `session_id` | `{ status, reply?, workspace_changes? }` | `streamRegistry` + persisted history |
| `get_workspace` | `session_id`, `path?` | file tree or file content | `workspaceManager.listWorkspaceFilesFromS3` / read |

`autoApprove` recommendation for clients: the read-only tools
(`list_scopes`, `list_agents`, `chat_result`, `get_workspace`); leave `chat`
requiring approval.

### Tool → service mapping notes
- `list_scopes` / `list_agents` are thin reads scoped by `organizationId` from
  the API key. Good candidates for a short cache.
- `chat` accepts either `agent_id` (legacy agent flow) or `scope_id` (business
  scope flow), matching `ChatStreamOptions` (`agentId` | `businessScopeId`).
  Passing `session_id` continues an existing Super Agent conversation.
- `get_workspace` reuses the S3 workspace read path
  (`org/scope/session/` prefix) — the same path fixed for history sessions.

---

## 5. The streaming → request/response bridge (core design point)

Agent runs vary from seconds to minutes. `chat` uses **blocking with async
fallback** so short tasks feel like one turn and long tasks don't hit connection
timeouts.

1. `chat` starts the run against `chatService.streamChat`. Because `streamChat`
   writes to a Fastify `reply`, the MCP tool drives it via a captured/synthetic
   sink and **subscribes to `streamRegistry`** for the session's events (the same
   mechanism the `GET /api/chat/sessions/:id/stream` endpoint uses).
2. The tool **aggregates events up to a soft deadline** (`~60–90 s`,
   configurable via env, e.g. `MCP_CHAT_BLOCK_MS`), emitting **MCP progress
   notifications** so the IDE shows "agent is working…".
3. **Short task** — completes within the window → return
   `{ status: "completed", session_id, reply, workspace_changes }`.
4. **Long task** — deadline hit, run still active (`streamRegistry.isActive`) →
   return `{ status: "running", session_id, progress }`. The IDE (or user) then
   calls `chat_result` with the `session_id` to poll until `completed`.

This mirrors the proven async run→poll pattern in `openapi.routes.ts`
(`POST /v1/openapi/workflow/:id/run` returns an id + `status`, then
`GET /v1/openapi/execution/:id`), applied to chat sessions.

### Session continuity
`session_id` threads across turns: absent → new session; present → resume. This
reuses the existing `claude_session_id` / `claude_session_model` resume
machinery, so multi-turn context and the per-session workspace persist between
IDE turns.

### Returning the work
Agent output is text **plus workspace files**. `chat`'s response includes a
`workspace_changes` summary (changed file list); the IDE fetches contents via
`get_workspace` (or we optionally expose the workspace as **MCP resources** in a
later iteration). This is where the S3 workspace read path is reused.

---

## 6. Authentication & tenancy

- **Transport auth:** `Authorization: Bearer sk_…` (also accept `x-api-key`),
  validated by the same `apiKeyAuth` used in `llm-proxy.routes.ts` /
  `openapi.routes.ts`:
  - `apiKeyService.validateApiKey` → `{ organizationId, userId, scopes,
    rateLimitPerMinute }`
  - per-minute rate limit via `apiKeyService.checkRateLimit`
  - also accept the `internal.*` HMAC service token (parity with the proxy),
    though external IDEs will use real keys.
- **New scope:** `mcp:tools` (gated in the `/v1/mcp` auth). API-key scopes are
  free-form strings (`apiKeys.routes.ts` `createApiKeySchema` accepts any
  `string[]`), so **no api-key route change is needed** — issue an IDE key with
  `scopes: ["mcp:tools"]`.
- **Tenancy:** every tool passes the key's `organizationId` into the service
  call. No cross-org access is possible because the repositories filter on
  `organization_id`. `userId` from the key is used where a creator/actor is
  needed.
- **Key management:** unchanged — issue/revoke via existing `/api/api-keys`
  (JWT-protected UI). Document a "create an MCP key" flow in the user manual.

---

## 7. Deployment & wiring

1. **Dependency:** add `@modelcontextprotocol/sdk` to `backend/package.json`
   (pin an exact, known-good version; verify `McpServer` +
   `StreamableHTTPServerTransport` import paths against the installed version).
2. **Route:** new `backend/src/routes/mcp-server.routes.ts` registered **without
   a `/api` prefix** (like `llmProxyRoutes`) so it serves at `/v1/mcp`. Register
   in `backend/src/routes/index.ts` near the other `/v1/*` registrations.
3. **CloudFront:** *no change needed.* The existing `/v1/*` behavior
   (`infra/lib/super-agent-ecs-stack.ts:510`) already routes `/v1/mcp` to the
   ALB with caching **disabled**, `originRequestPolicy: ALL_VIEWER`, and
   `ALLOW_ALL` methods — so bearer headers and SSE chunks pass through. Because
   `/v1/mcp` falls under `/v1/*`, deploying the MCP endpoint is a backend-image
   roll only (`--skip-cdk`).
4. **No IAM/env changes required** for phase 1 (the backend already has its DB,
   Redis, S3, and AgentCore-invoke permissions). Optional new env:
   `MCP_CHAT_BLOCK_MS` (soft deadline).
5. **Deploy:** rebuild the arm64 backend image and roll the ECS service
   (`--skip-cdk` unless the CloudFront behavior changed; run full CDK when the
   stack changed). Same procedure used for the workspace fix.

### Client config
Kiro `.kiro/settings/mcp.json`:
```json
{
  "mcpServers": {
    "super-agent": {
      "url": "https://<dev9-domain>/v1/mcp",
      "headers": { "Authorization": "Bearer ${SUPER_AGENT_API_KEY}" },
      "autoApprove": ["list_scopes", "list_agents", "chat_result", "get_workspace"]
    }
  }
}
```
Amazon Q: equivalent remote-server entry under `~/.aws/amazonq/agents/default.json`
(IDE) or `~/.aws/amazonq/cli-agents` (CLI).

---

## 8. Phase 2 (deferred): AgentCore Gateway

When enterprise governance is needed — Cedar policy authorization per tool/arg,
semantic tool search (20+ tools), aggregation of multiple internal services,
centralized inbound auth — front phase-1 with an **AgentCore Gateway**
(the pattern in `aws-samples/sample-integrate-enterprise-ai-services-via-agentcore`):

- Gateway with **Cognito JWT inbound auth**; add a Cognito resource server + app
  client. For Kiro/Q, the app client must be a **public PKCE client** (Kiro does
  browser OAuth; note Gateway does **not** implement MCP OAuth auto-discovery /
  dynamic client registration, so clients may need `client_id` entered manually).
- Target = either the phase-1 `/v1/mcp` as an **`mcp-server`** target, or the
  existing `openapi.routes.ts` as an **OpenAPI→MCP** target with **api-key**
  outbound auth (reuses `api_keys`).
- Phase 1 remains the backend; Gateway is an additive front. No rework.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Long agent runs exceed HTTP/idle timeouts | Blocking + async-poll (`chat` → `chat_result`); soft deadline env; progress notifications keep the connection warm |
| MCP SDK API drift (v1 single-package vs v2 split packages) | Pin exact version; verify `McpServer` / `StreamableHTTPServerTransport` imports at install time before coding tools |
| `streamChat` requires a `FastifyReply` | Drive via `streamRegistry` subscription + a synthetic sink; do not couple the MCP tool to a real HTTP reply |
| CloudFront buffering breaking SSE | `/v1/*` behavior already caching-disabled + ALL_VIEWER; confirm `/v1/mcp` inherits it |
| Over-broad API keys | Dedicated `mcp:tools` scope; keys issued per IDE user; rate-limited; revocable |
| Cross-tenant leakage | `organizationId` from the key flows into every service call; repos filter on it |

---

## 10. Phase-1 checklist

- [x] Add `@modelcontextprotocol/sdk` dependency — pinned `1.30.0`; imports
      verified (`.../server/mcp.js`, `.../server/streamableHttp.js`)
- [x] `mcp-server.routes.ts`: `/v1/mcp` with `StreamableHTTPServerTransport`
      (stateless) + bearer `api_keys` auth + `mcp:tools` scope
- [x] Tools: `list_scopes`, `list_agents`, `chat`, `chat_result`, `get_workspace`
- [x] `chat` blocking+async bridge over `chatService.processMessage` (the
      non-streaming variant returning `{text, sessionId, contentBlocks}`) with an
      in-memory job map, soft deadline `MCP_CHAT_BLOCK_MS` (default 75s), and a
      `chat_result` poll tool. (Uses `processMessage`, not a synthetic `reply`
      around `streamChat` — cleaner and avoids faking a `FastifyReply`.)
- [x] Register route in `index.ts`
- [x] CloudFront: no change — `/v1/*` behavior (stack `:510`) already covers
      `/v1/mcp` (caching off, ALL_VIEWER, ALLOW_ALL)
- [x] API-key scopes are free-form → no api-key route change; issue key with
      `scopes:["mcp:tools"]`
- [x] Local verify: end-to-end MCP client↔server smoke test over real HTTP
      (listTools + callTool) passed; backend typecheck clean for touched files
- [ ] Deploy backend image to Dev9 (`--skip-cdk`) and verify from Kiro/Q
- [ ] Document "create an MCP API key" + Kiro/Q client config in the user manual

### Implementation notes (as built)
- Files: `backend/src/routes/mcp-server.routes.ts` (new),
  `backend/src/routes/index.ts` (register), `backend/package.json` (dep).
- `chat` keys its background job by `session_id`; a new session is re-keyed to
  the real id once `processMessage` returns, so `chat_result` can find it.
- Jobs are in-memory + best-effort; a restart drops in-flight jobs but the
  reply is still persisted to chat history. Reaped 30 min after finishing.
- Stateless transport (`sessionIdGenerator: undefined`): one server+transport
  per POST; GET/DELETE return 405 JSON-RPC. `reply.hijack()` hands the socket
  to the transport (so Fastify's `onResponse` audit hook is bypassed for `/v1/mcp`).
