import { describe, expect, it, vi } from 'vitest';
import { processSSEStream } from './scopeGeneratorService';

function readerFor(events: unknown[]) {
  const encoder = new TextEncoder();
  const payload = events
    .map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
    .join('');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }).getReader();
}

describe('scope generator SSE processing', () => {
  it('surfaces the backend generation error instead of returning empty content', async () => {
    const onEvent = vi.fn();
    const reader = readerFor([
      {
        type: 'error',
        code: 'AGENTCORE_CODEX_MODEL_UNSUPPORTED',
        message: 'AgentCore Codex requires an OpenAI model available through Amazon Bedrock',
      },
      '[DONE]',
    ]);

    await expect(processSSEStream(reader, onEvent)).rejects.toThrow(
      'AgentCore Codex requires an OpenAI model available through Amazon Bedrock',
    );
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('returns the validated scope_config payload when generation succeeds', async () => {
    const config = {
      scope: {
        name: 'Release Engineering',
        description: 'Release automation',
        icon: 'R',
        color: '#2563EB',
      },
      agents: [],
    };

    await expect(processSSEStream(
      readerFor([{ type: 'scope_config', content: JSON.stringify(config) }, '[DONE]']),
      vi.fn(),
    )).resolves.toBe(JSON.stringify(config));
  });
});
