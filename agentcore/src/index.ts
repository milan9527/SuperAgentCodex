/**
 * Codex AgentCore Runtime Entry Point
 *
 * Implements the AgentCore HTTP protocol contract:
 *   POST /invocations  — run agent, return SSE stream
 *   GET  /ping         — health check
 *
 * Data flow:
 *   1. Backend prepares full workspace locally and uploads to S3
 *   2. Backend invokes AgentCore with S3 bucket/prefix in payload
 *   3. Container downloads entire workspace from S3 → /workspace/
 *   4. Runs Codex app-server with cwd=/workspace and an isolated CODEX_HOME
 *   5. Waits for diff upload and a full deletion-aware S3 mirror before ending
 */

import http from 'http';
import { S3Client } from '@aws-sdk/client-s3';
import { runAgent } from './agent-runner.js';
import {
  restoreWorkspaceFromS3,
  syncWorkspaceToS3,
  uploadWorkspaceDiff,
} from './workspace-sync.js';
import { createGitBaseline } from './agent-runner.js';
import { initOtel } from './otel.js';
import type { AgentPayload, AgentEvent } from './types.js';

const PORT = Number(process.env.PORT ?? 8080);

// S3 client for workspace sync.
// Keep the workspace S3 region independent from the Bedrock/AgentCore region.
// They are both us-east-1 in the default deployment, but explicit configuration
// prevents a future regional split from silently routing S3 requests elsewhere.
const S3_REGION = process.env.WORKSPACE_S3_REGION ?? 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

// ---------------------------------------------------------------------------
// /invocations
// ---------------------------------------------------------------------------

async function handleInvocations(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  let payload: AgentPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
    return;
  }

  const bucket = payload.workspace_s3_bucket;
  const prefix = payload.workspace_s3_prefix;

  // --- Restore full workspace from S3 → /workspace/ ---
  if (bucket && prefix) {
    try {
      const count = await restoreWorkspaceFromS3(s3, bucket, prefix);
      console.log(`[index] Restored ${count} files from s3://${bucket}/${prefix}`);
    } catch (err) {
      console.error('[index] Workspace restore failed:', err);
    }

    // Create git baseline snapshot for diff tracking
    createGitBaseline();
  }

  // --- Set backend connectivity env vars for skills (e.g. knowledge-search) ---
  if (payload.backend_api_url) {
    process.env.API_BASE_URL = payload.backend_api_url;
  }
  if (payload.backend_api_key) {
    process.env.AUTH_TOKEN = payload.backend_api_key;
  }

  // --- SSE streaming response ---
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const stream = runAgent(payload, req.headers as Record<string, unknown>);
  const stopOnDisconnect = (): void => {
    void stream.return(undefined).catch(() => {});
  };
  res.once('close', stopOnDisconnect);

  try {
    // Pass the inbound HTTP headers so OTEL can extract any forwarded trace
    // context (traceparent / X-Amzn-Trace-Id) and parent our spans on the
    // platform's AgentCore.Runtime.Invoke span → one connected trace per turn.
    for await (const event of stream) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    const errorEvent: AgentEvent = {
      type: 'error',
      code: 'AGENT_EXECUTION_ERROR',
      message: err instanceof Error ? err.message : String(err),
    };
    res.write(`data: ${JSON.stringify(errorEvent)}\n\n`);
  } finally {
    res.off('close', stopOnDisconnect);
    if (bucket && prefix) {
      await uploadWorkspaceDiff(s3, bucket, prefix);
      const result = await syncWorkspaceToS3(s3, bucket, prefix);
      console.log(
        `[index] Final workspace mirror complete `
        + `(uploaded=${result.uploaded}, deleted=${result.deleted})`,
      );
    }
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// /ping
// ---------------------------------------------------------------------------

function handlePing(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'Healthy',
    time_of_last_update: Math.floor(Date.now() / 1000),
  }));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/invocations') {
      await handleInvocations(req, res);
    } else if (req.method === 'GET' && req.url === '/ping') {
      handlePing(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('[index] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// Initialize OpenTelemetry (no-op unless AGENT_OBSERVABILITY_ENABLED=true).
// Fire-and-forget: sets up global providers before the first invocation.
void initOtel();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[agentcore-runner] Listening on 0.0.0.0:${PORT}`);
});
