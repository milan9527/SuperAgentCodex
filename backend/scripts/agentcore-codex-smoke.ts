import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

interface AgentCoreEvent {
  type?: string;
  status?: string;
  code?: string;
  message?: string;
  provider_thread_id?: string;
  provider_turn_id?: string;
  content?: Array<{ type?: string; text?: string }>;
  workspace_sync?: {
    uploaded?: number;
    deleted?: number;
    diff_uploaded?: boolean;
  };
}

const runtimeArn = requiredEnv('AGENTCORE_RUNTIME_ARN');
const bucket = requiredEnv('AGENTCORE_WORKSPACE_S3_BUCKET');
const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
const workspaceRegion = process.env.WORKSPACE_S3_REGION ?? 'us-east-1';
const model = process.env.CODEX_E2E_MODEL ?? 'openai.gpt-5.4';
const runId = process.env.AGENTCORE_E2E_RUN_ID ?? randomUUID();
const prefix = `codex-validation/${runId}/`;
const sessionId = `codex-agentcore-e2e-${runId}`.replace(/[^A-Za-z0-9_-]/g, '_').padEnd(33, '_');
const expectedResponse = 'CODEX_AGENTCORE_E2E_OK';
const expectedFile = 'CODEX_AGENTCORE_FILE_OK';

const agentCore = new BedrockAgentCoreClient({ region });
const s3 = new S3Client({ region: workspaceRegion });

await s3.send(new PutObjectCommand({
  Bucket: bucket,
  Key: `${prefix}AGENTS.md`,
  Body: [
    '# Validation Workspace',
    '',
    'Follow the user request exactly. Keep the final response concise.',
    '',
  ].join('\n'),
  ContentType: 'text/markdown',
}));

const payload = {
  protocol_version: 2,
  runtime: 'codex',
  prompt: [
    `Create codex-agentcore-proof.txt containing exactly ${expectedFile} followed by a newline.`,
    `Then respond with exactly ${expectedResponse} and no other text.`,
  ].join(' '),
  chat_session_id: sessionId,
  scope_id: 'codex-validation',
  org_id: 'codex-validation',
  agent_id: 'codex-validation',
  model,
  model_provider: 'amazon-bedrock',
  aws_region: region,
  reasoning_effort: 'high',
  workspace_s3_bucket: bucket,
  workspace_s3_prefix: prefix,
};

const response = await agentCore.send(new InvokeAgentRuntimeCommand({
  agentRuntimeArn: runtimeArn,
  runtimeSessionId: sessionId,
  qualifier: 'DEFAULT',
  contentType: 'application/json',
  accept: 'text/event-stream',
  payload: Buffer.from(JSON.stringify(payload)),
}));

let buffer = '';
let assistantText = '';
let terminal: AgentCoreEvent | undefined;
const events: AgentCoreEvent[] = [];
let terminalCount = 0;

for await (const chunk of response.response) {
  buffer += Buffer.from(chunk).toString('utf8');
  const frames = buffer.split(/\r?\n\r?\n/);
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    for (const line of frame.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5).trim()) as AgentCoreEvent;
      events.push(event);
      if (event.type === 'assistant') {
        const text = event.content
          ?.filter(block => block.type === 'text')
          .map(block => block.text ?? '')
          .join('') ?? '';
        assistantText += text;
      }
      if (event.type === 'result' || event.type === 'error') {
        terminal = event;
        terminalCount++;
      }
    }
  }
}

if (terminal?.type !== 'result' || terminal.status !== 'completed') {
  throw new Error(
    `AgentCore Codex did not complete: ${JSON.stringify(terminal ?? events.at(-1))}`,
  );
}
if (terminalCount !== 1) {
  throw new Error(`Expected exactly one terminal event, got ${terminalCount}`);
}
const syncIndex = events.findIndex(event => event.workspace_sync);
const terminalIndex = events.findIndex(event => event === terminal);
if (syncIndex < 0 || terminalIndex < 0 || syncIndex >= terminalIndex) {
  throw new Error(
    `Workspace sync must be confirmed before terminal: ${JSON.stringify(events)}`,
  );
}
const streamedText = assistantText.trim();
if (!streamedText.endsWith(expectedResponse)) {
  throw new Error(
    `Assistant stream did not end with ${expectedResponse}: ${JSON.stringify(assistantText)}`,
  );
}

const proof = await s3.send(new GetObjectCommand({
  Bucket: bucket,
  Key: `${prefix}codex-agentcore-proof.txt`,
}));
const proofText = await proof.Body?.transformToString();
if (proofText?.trim() !== expectedFile) {
  throw new Error(`Unexpected workspace proof: ${JSON.stringify(proofText)}`);
}

console.log(JSON.stringify({
  ok: true,
  runtimeArn,
  region,
  workspaceRegion,
  model,
  sessionId,
  workspace: `s3://${bucket}/${prefix}`,
  providerThreadId: terminal.provider_thread_id,
  providerTurnId: terminal.provider_turn_id,
  response: expectedResponse,
  proof: proofText.trim(),
  workspaceSync: events[syncIndex]?.workspace_sync,
}, null, 2));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
