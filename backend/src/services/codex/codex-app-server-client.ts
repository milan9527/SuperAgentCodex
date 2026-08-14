import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CodexNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerTransport {
  start(): Promise<void>;
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  notifications(): AsyncGenerator<CodexNotification>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerClientOptions {
  executablePath?: string;
  cwd?: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

class AsyncNotificationQueue {
  private values: CodexNotification[] = [];
  private waiters: Array<(result: IteratorResult<CodexNotification>) => void> = [];
  private ended = false;
  private failure: Error | null = null;

  push(value: CodexNotification): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = error ?? null;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<CodexNotification>> {
    const value = this.values.shift();
    if (value) return { value, done: false };
    if (this.ended) {
      if (this.failure) throw this.failure;
      return { value: undefined, done: true };
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

export class CodexAppServerClient implements CodexAppServerTransport {
  private readonly options: Required<Pick<CodexAppServerClientOptions, 'executablePath' | 'requestTimeoutMs'>> & CodexAppServerClientOptions;
  private readonly queue = new AsyncNotificationQueue();
  private readonly pending = new Map<number | string, PendingRequest>();
  private process: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private started = false;
  private closing = false;
  private stderrTail = '';

  constructor(options: CodexAppServerClientOptions = {}) {
    this.options = {
      ...options,
      executablePath: options.executablePath ?? 'codex',
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
    };
  }

  async start(): Promise<void> {
    if (this.started) return;

    const env = { ...process.env, ...this.options.env };
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(
      this.options.executablePath,
      ['--dangerously-bypass-hook-trust', 'app-server', '--stdio'],
      {
        cwd: this.options.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.process = child;

    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => this.handleLine(line));
    child.stderr.on('data', chunk => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-8_192);
    });
    child.once('error', error => this.handleExit(error));
    child.once('exit', (code, signal) => {
      if (this.closing) {
        this.queue.end();
        return;
      }
      const detail = this.stderrTail.trim();
      const suffix = detail ? `: ${detail}` : '';
      this.handleExit(
        new Error(`Codex app-server exited (code=${String(code)}, signal=${String(signal)})${suffix}`),
      );
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'super-agent-platform',
        title: 'Super Agent Platform',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.notify('initialized');
    this.started = true;
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.options.requestTimeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  async *notifications(): AsyncGenerator<CodexNotification> {
    for (;;) {
      const next = await this.queue.next();
      if (next.done) return;
      yield next.value;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.process;
    this.process = null;
    this.queue.end();
    this.rejectPending(new Error('Codex app-server client closed'));
    if (!child || child.exitCode !== null) return;

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      timer.unref?.();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('Codex app-server is not running');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.handleExit(new Error('Codex app-server emitted malformed JSON'));
      return;
    }
    if (!message || typeof message !== 'object') return;

    const record = message as Record<string, unknown>;
    if (record.id !== undefined && ('result' in record || 'error' in record)) {
      const response = record as unknown as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.error) {
        pending.reject(
          new Error(
            `Codex app-server RPC error ${String(response.error.code ?? '')}: ${response.error.message ?? 'unknown error'}`,
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (typeof record.method === 'string' && record.id === undefined) {
      this.queue.push({ method: record.method, params: record.params });
      return;
    }

    // Interactive approvals are disabled for this integration. Fail closed if
    // a future server version still sends a request.
    if (typeof record.method === 'string' && record.id !== undefined) {
      this.write({
        id: record.id,
        error: {
          code: -32601,
          message: `Unsupported app-server request: ${record.method}`,
        },
      });
    }
  }

  private handleExit(error: Error): void {
    this.rejectPending(error);
    this.queue.end(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
