import { resolve } from 'node:path';
import {
  CodexAppServerClient,
} from '../src/services/codex/codex-app-server-client.js';
import {
  adaptCodexNotification,
  createCodexAdapterState,
} from '../src/services/codex/codex-event-adapter.js';

const cwd = resolve(process.env.CODEX_E2E_WORKSPACE ?? process.cwd());
const model = process.env.CODEX_E2E_MODEL ?? 'openai.gpt-5.4';
const modelProvider = process.env.CODEX_E2E_MODEL_PROVIDER ?? 'amazon-bedrock';
const timeoutMs = Number(process.env.CODEX_E2E_TIMEOUT_MS ?? 180_000);

const client = new CodexAppServerClient({
  executablePath: process.env.CODEX_EXECUTABLE ?? 'codex',
  codexHome: process.env.CODEX_HOME,
  cwd,
  requestTimeoutMs: 30_000,
});

let timer: NodeJS.Timeout | undefined;
try {
  await client.start();
  const thread = await client.request<{ thread: { id: string }; model?: string }>(
    'thread/start',
    {
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      model,
      modelProvider,
      allowProviderModelFallback: false,
      serviceName: 'super-agent-codex-smoke',
      ephemeral: true,
      config: {
        model_providers: {
          'amazon-bedrock': {
            aws: {
              region: process.env.AWS_REGION
                ?? process.env.AWS_DEFAULT_REGION
                ?? 'us-east-1',
            },
          },
        },
      },
    },
  );
  const turn = await client.request<{ turn: { id: string } }>('turn/start', {
    threadId: thread.thread.id,
    input: [{
      type: 'text',
      text: 'Reply with exactly CODEX_E2E_OK. Do not use tools.',
      text_elements: [],
    }],
    cwd,
    runtimeWorkspaceRoots: [cwd],
    approvalPolicy: 'never',
    model,
    effort: 'low',
  });

  const state = createCodexAdapterState(thread.thread.id, thread.model ?? model);
  state.turnId = turn.turn.id;
  let text = '';
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Codex E2E timed out')), timeoutMs);
  });
  const run = (async () => {
    for await (const notification of client.notifications()) {
      for (const event of adaptCodexNotification(notification, state)) {
        if (event.type === 'assistant') {
          text += event.content
            ?.filter(block => block.type === 'text')
            .map(block => block.text)
            .join('') ?? '';
        }
        if (event.type === 'error') {
          throw new Error(`${event.code ?? 'CODEX_ERROR'}: ${event.message ?? 'unknown error'}`);
        }
      }
      if (state.terminal) return;
    }
    throw new Error('Codex app-server closed before turn completion');
  })();

  await Promise.race([run, deadline]);
  if (!text.includes('CODEX_E2E_OK')) {
    throw new Error(`Unexpected Codex response: ${text || '(empty)'}`);
  }
  console.log(JSON.stringify({
    ok: true,
    provider: modelProvider,
    model,
    threadId: thread.thread.id,
    turnId: turn.turn.id,
    response: text.trim(),
  }, null, 2));
} finally {
  if (timer) clearTimeout(timer);
  await client.close().catch(() => {});
}
