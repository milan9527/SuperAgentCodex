import { describe, expect, it, vi } from 'vitest';
import { ConversationEventCoalescer } from '../../src/services/conversation-event-coalescer.js';
import type { ConversationEvent } from '../../src/services/agent-types.js';

function text(text: string, overrides: Partial<ConversationEvent> = {}): ConversationEvent {
  return {
    type: 'assistant',
    providerThreadId: 'thread-1',
    providerTurnId: 'turn-1',
    model: 'openai.gpt-5.4',
    status: 'in_progress',
    content: [{ type: 'text', text }],
    ...overrides,
  };
}

describe('ConversationEventCoalescer', () => {
  it('coalesces character-sized Chinese deltas on a short timer', () => {
    vi.useFakeTimers();
    const emitted: ConversationEvent[] = [];
    const coalescer = new ConversationEventCoalescer(event => emitted.push(event), {
      delayMs: 60,
      maxChars: 32,
    });

    coalescer.push(text('我'));
    coalescer.push(text('先'));
    coalescer.push(text('看'));
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(60);
    expect(emitted).toEqual([
      expect.objectContaining({
        content: [{ type: 'text', text: '我先看' }],
      }),
    ]);
    vi.useRealTimers();
  });

  it('flushes pending text before a tool event', () => {
    const emitted: ConversationEvent[] = [];
    const coalescer = new ConversationEventCoalescer(event => emitted.push(event));
    const tool: ConversationEvent = {
      type: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { path: 'AGENTS.md' },
      }],
    };

    coalescer.push(text('正在读取'));
    coalescer.push(tool);

    expect(emitted).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: '正在读取' }] }),
      tool,
    ]);
  });

  it('does not merge text across speakers', () => {
    const emitted: ConversationEvent[] = [];
    const coalescer = new ConversationEventCoalescer(event => emitted.push(event));

    coalescer.push(text('主代理', { speakerAgentName: 'Main' }));
    coalescer.push(text('子代理', { speakerAgentName: 'Subagent' }));
    coalescer.flush();

    expect(emitted.map(event => event.content)).toEqual([
      [{ type: 'text', text: '主代理' }],
      [{ type: 'text', text: '子代理' }],
    ]);
  });

  it('flushes immediately when the character threshold is reached', () => {
    const emitted: ConversationEvent[] = [];
    const coalescer = new ConversationEventCoalescer(event => emitted.push(event), {
      delayMs: 1000,
      maxChars: 4,
    });

    coalescer.push(text('回答'));
    coalescer.push(text('完成'));

    expect(emitted).toEqual([
      expect.objectContaining({ content: [{ type: 'text', text: '回答完成' }] }),
    ]);
  });
});
