import { createHash } from 'node:crypto';
import path from 'node:path';
import type { AgentPayload } from './types.js';

export class SerializedInvocationGate {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let releaseSlot!: () => void;
    const slot = new Promise<void>(resolve => {
      releaseSlot = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => slot);
    await previous;

    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseSlot();
    };
  }
}

export function invocationCodexHome(
  payload: AgentPayload,
  root = '/tmp/super-agent-codex-homes',
): string {
  const identity = [
    payload.org_id ?? 'unknown-org',
    payload.scope_id ?? 'unknown-scope',
    payload.chat_session_id
      ?? payload.session_id
      ?? payload.provider_thread_id
      ?? 'ephemeral',
  ].join('\0');
  const digest = createHash('sha256').update(identity).digest('hex');
  return path.join(root, digest);
}

export function applyScopedEnvironment(
  values: Record<string, string | undefined>,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
