import type { ConversationEvent } from './agent-types.js';

export interface ConversationEventCoalescerOptions {
  delayMs?: number;
  maxChars?: number;
}

const DEFAULT_DELAY_MS = 60;
const DEFAULT_MAX_CHARS = 32;

/**
 * Coalesces adjacent text-only assistant deltas without delaying tools or
 * terminal events. Codex can emit one CJK character per delta, which is useful
 * provider detail but too granular for an SSE/UI rendering boundary.
 */
export class ConversationEventCoalescer {
  private readonly delayMs: number;
  private readonly maxChars: number;
  private pending: ConversationEvent | undefined;
  private pendingChars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (event: ConversationEvent) => void,
    options: ConversationEventCoalescerOptions = {},
  ) {
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  push(event: ConversationEvent): void {
    const text = textOnlyContent(event);
    if (text === undefined) {
      this.flush();
      this.emit(event);
      return;
    }

    if (!this.pending || eventSignature(this.pending) !== eventSignature(event)) {
      this.flush();
      this.pending = {
        ...event,
        content: [{ type: 'text', text }],
      };
      this.pendingChars = text.length;
      this.startTimer();
    } else {
      const block = this.pending.content?.[0];
      if (block?.type === 'text') block.text += text;
      this.pendingChars += text.length;
    }

    if (this.pendingChars >= this.maxChars) this.flush();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const event = this.pending;
    this.pending = undefined;
    this.pendingChars = 0;
    if (event) this.emit(event);
  }

  private startTimer(): void {
    this.timer = setTimeout(() => this.flush(), this.delayMs);
    this.timer.unref?.();
  }
}

function textOnlyContent(event: ConversationEvent): string | undefined {
  if (event.type !== 'assistant' || !event.content?.length) return undefined;
  if (event.content.some(block => block.type !== 'text')) return undefined;
  return event.content.map(block => block.type === 'text' ? block.text : '').join('');
}

function eventSignature(event: ConversationEvent): string {
  return JSON.stringify([
    event.provider,
    event.sessionId,
    event.providerThreadId,
    event.providerTurnId,
    event.status,
    event.model,
    event.speakerAgentName,
    event.speakerAgentAvatar,
  ]);
}
