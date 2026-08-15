import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import {
  AgentCoreAgentRuntime,
  isPersistedChatSessionId,
} from '../../src/services/agent-runtime-agentcore.js';
import type { AgentConfig } from '../../src/services/agent-types.js';

class FakeInvokeCommand {
  constructor(readonly input: unknown) {}
}

const agentConfig: AgentConfig = {
  id: 'agent-1',
  name: 'agent-1',
  displayName: 'Agent 1',
  systemPrompt: 'Stay scoped.',
  model: 'openai.gpt-5.4',
  resolvedModel: {
    provider: 'bedrock',
    modelId: 'openai.gpt-5.4',
  },
  organizationId: 'org-1',
  skillIds: [],
  mcpServerIds: [],
};

describe('AgentCoreAgentRuntime Codex integration', () => {
  it('only loads database history for persisted UUID chat sessions', () => {
    expect(isPersistedChatSessionId('5034b493-42e6-4ff8-9e13-a0e474824fc9')).toBe(true);
    expect(isPersistedChatSessionId('scope-gen-1786681698673-71jlzh')).toBe(false);
    expect(isPersistedChatSessionId(undefined)).toBe(false);
  });

  it('sends Codex thread, image, history, and model-provider fields', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentcore-runtime-'));
    await writeFile(join(workspace, 'image.png'), Buffer.from([137, 80, 78, 71]));
    let commandInput: Record<string, unknown> | undefined;
    const runtimeClient = {
      async send(command: FakeInvokeCommand): Promise<unknown> {
        commandInput = command.input as Record<string, unknown>;
        return {
          contentType: 'text/event-stream',
          response: Readable.from([
            'data: {"type":"session_start","provider":"codex",'
              + '"session_id":"thread-new","provider_thread_id":"thread-new",'
              + '"status":"in_progress","model":"openai.gpt-5.4"}\n\n',
            'data: {"type":"result","provider":"codex",'
              + '"session_id":"thread-new","provider_thread_id":"thread-new",'
              + '"provider_turn_id":"turn-1","status":"completed"}\n\n',
          ]),
        };
      },
    };
    const s3 = createS3Mock();
    const runtime = new AgentCoreAgentRuntime({
      runtimeClient,
      InvokeCommand: FakeInvokeCommand,
      s3Client: s3,
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/new',
      workspaceBucket: 'workspace-bucket',
    });

    try {
      const events = [];
      for await (const event of runtime.runConversation({
        agentId: 'agent-1',
        sessionId: 'platform-session-that-is-long-enough-123',
        providerThreadId: 'thread-existing',
        message: 'continue',
        history: [{ role: 'user', content: 'earlier' }],
        imagePaths: ['image.png'],
        organizationId: 'org-1',
        userId: 'user-1',
        workspacePath: workspace,
      }, agentConfig, [])) {
        events.push(event);
      }

      const payload = JSON.parse(commandInput?.payload as string);
      expect(payload).toMatchObject({
        protocol_version: 2,
        runtime: 'codex',
        provider_thread_id: 'thread-existing',
        model: 'openai.gpt-5.4',
        model_provider: 'amazon-bedrock',
        aws_region: 'us-east-1',
        reasoning_effort: 'high',
        image_paths: ['image.png'],
        history: [{ role: 'user', content: 'earlier' }],
      });
      expect(events[0]).toMatchObject({
        type: 'session_start',
        provider: 'agentcore',
        providerThreadId: 'thread-new',
      });
      expect(events[1]).toMatchObject({
        type: 'result',
        status: 'completed',
        providerTurnId: 'turn-1',
      });
      expect(s3.listCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('aborts an active AgentCore invocation by platform session id', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentcore-abort-'));
    const runtimeClient = {
      send(_command: FakeInvokeCommand, options: { abortSignal: AbortSignal }): Promise<unknown> {
        return new Promise((_, reject) => {
          options.abortSignal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      },
    };
    const runtime = new AgentCoreAgentRuntime({
      runtimeClient,
      InvokeCommand: FakeInvokeCommand,
      s3Client: createS3Mock(),
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/new',
      workspaceBucket: 'workspace-bucket',
    });
    const generator = runtime.runConversation({
      agentId: 'agent-1',
      sessionId: 'platform-session-that-is-long-enough-456',
      message: 'wait',
      history: [],
      organizationId: 'org-1',
      userId: 'user-1',
      workspacePath: workspace,
    }, agentConfig, []);

    try {
      const nextEvent = generator.next();
      await waitUntil(() => runtime.hasSession('platform-session-that-is-long-enough-456'));
      await runtime.disconnectSession('platform-session-that-is-long-enough-456');
      await expect(nextEvent).resolves.toMatchObject({
        value: { type: 'result', status: 'interrupted' },
      });
      await generator.next();
      expect(runtime.activeSessionCount).toBe(0);
    } finally {
      await generator.return(undefined);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('removes local files that no longer exist in the S3 workspace mirror', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentcore-syncback-'));
    await writeFile(join(workspace, 'stale.txt'), 'stale');
    const s3 = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof ListObjectsV2Command) {
          return { Contents: [{ Key: 'prefix/current.txt' }] };
        }
        if (command instanceof GetObjectCommand) {
          return { Body: Readable.from(['current']) };
        }
        throw new Error(`Unexpected command: ${String(command)}`);
      },
    } as unknown as S3Client;
    const runtime = new AgentCoreAgentRuntime({
      runtimeClient: { send: async () => ({}) },
      InvokeCommand: FakeInvokeCommand,
      s3Client: s3,
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/new',
      workspaceBucket: 'workspace-bucket',
    });

    try {
      await runtime.syncBackFromS3('prefix/', workspace);
      await expect(readFile(join(workspace, 'stale.txt'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(workspace, 'current.txt'), 'utf8')).resolves.toBe('current');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fails before invocation when the initial workspace upload fails', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentcore-upload-failure-'));
    await writeFile(join(workspace, 'input.txt'), 'input');
    let invoked = false;
    const s3 = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof PutObjectCommand) throw new Error('upload denied');
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        throw new Error(`Unexpected command: ${String(command)}`);
      },
    } as unknown as S3Client;
    const runtime = new AgentCoreAgentRuntime({
      runtimeClient: {
        async send(): Promise<unknown> {
          invoked = true;
          return {};
        },
      },
      InvokeCommand: FakeInvokeCommand,
      s3Client: s3,
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/new',
      workspaceBucket: 'workspace-bucket',
    });

    try {
      const consume = async (): Promise<void> => {
        for await (const _event of runtime.runConversation({
          agentId: 'agent-1',
          sessionId: 'platform-session-that-is-long-enough-789',
          message: 'do not run',
          history: [],
          organizationId: 'org-1',
          userId: 'user-1',
          workspacePath: workspace,
        }, agentConfig, [])) {
          // The generator must fail before producing provider events.
        }
      };
      await expect(consume()).rejects.toThrow('Workspace upload failed');
      expect(invoked).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('refuses to sync through a workspace symlink', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agentcore-sync-symlink-'));
    const outside = await mkdtemp(join(tmpdir(), 'agentcore-sync-outside-'));
    await writeFile(join(outside, 'secret.txt'), 'unchanged');
    await symlink(outside, join(workspace, 'linked'));
    const s3 = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof ListObjectsV2Command) {
          return { Contents: [{ Key: 'prefix/linked/secret.txt' }] };
        }
        if (command instanceof GetObjectCommand) {
          return { Body: Readable.from(['overwritten']) };
        }
        throw new Error(`Unexpected command: ${String(command)}`);
      },
    } as unknown as S3Client;
    const runtime = new AgentCoreAgentRuntime({
      runtimeClient: { send: async () => ({}) },
      InvokeCommand: FakeInvokeCommand,
      s3Client: s3,
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/new',
      workspaceBucket: 'workspace-bucket',
    });

    try {
      await expect(runtime.syncBackFromS3('prefix/', workspace))
        .rejects.toThrow('Unsafe workspace parent');
      await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('unchanged');
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

function createS3Mock(): S3Client & { listCalls: number } {
  const mock = {
    listCalls: 0,
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) return {};
      if (command instanceof ListObjectsV2Command) {
        mock.listCalls++;
        return { Contents: [] };
      }
      throw new Error(`Unexpected S3 command: ${String(command)}`);
    },
  };
  return mock as unknown as S3Client & { listCalls: number };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
