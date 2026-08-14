# Codex SDK Migration

This directory tracks the implementation and validation specification for
migrating Super Agent from the Claude Agent SDK runtime to Codex.

Start with [MIGRATION_SPEC.md](./MIGRATION_SPEC.md).

The migration is implemented in the adjacent `backend`, `frontend`,
`agentcore`, and `infra` directories. Codex is selectable locally, and an
isolated Codex AgentCore Runtime passed the remote model, tool, SSE, S3 mirror,
and diff validation in `us-east-1`. Existing deployed AgentCore Runtimes were
not updated or deleted, and backend runtime configuration was not switched.

The specification includes:

- A repository-level audit of every current `AgentRuntime` consumer.
- A Claude-to-Codex feature parity matrix with blockers and verification tests.
- Native app-server event and legacy SSE compatibility contracts.
- Workspace, skills, subagents, MCP, hooks, plugins, and carry-forward rules.
- AgentCore container, cancellation, S3 synchronization, and telemetry gates.
- A module-by-module implementation list and release acceptance gates.

The current validation record is maintained at the top of
`MIGRATION_SPEC.md`. Historical `DESIGN` and `VALIDATE` rows remain useful as
the original audit, but the dated implementation record is authoritative.
