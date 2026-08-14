-- Track the model each Claude session was created with. Resuming a Claude Code
-- session keeps its original model, so a model switch must be detected against
-- THIS value (not the freshly-resolved scope/org default) to force a new session.
ALTER TABLE "chat_sessions" ADD COLUMN "claude_session_model" VARCHAR(255);
