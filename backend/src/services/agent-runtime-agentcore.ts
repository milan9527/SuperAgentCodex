/**
 * AgentCore Agent Runtime — runs Codex app-server inside Bedrock AgentCore
 * containers with a single shared runtime ARN.
 *
 * Before invoking AgentCore, the backend prepares the workspace (skills,
 * Codex config, agent files) and uploads it to S3. The container then
 * pulls everything from S3 — no need to call back to the backend API.
 *
 * Required env var:
 *   AGENTCORE_RUNTIME_ARN — the single runtime ARN to invoke
 */

import { config } from '../config/index.js';
import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type {
  ConversationEvent,
  AgentConfig,
  ContentBlock,
  MCPServerSDKConfig,
} from './agent-types.js';
import { createToken } from '../middleware/auth.js';
import type { SkillForWorkspace } from './workspace-manager.js';
import {
  DeleteObjectsCommand,
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { createReadStream, statSync, createWriteStream } from 'fs';
import { readdir, mkdir, rm, lstat } from 'fs/promises';
import { join, relative, dirname, resolve, sep } from 'path';
import { pipeline } from 'stream/promises';
import {
  isCodexBedrockModelId,
  normalizeCodexBedrockModelId,
} from '../utils/bedrock-openai-model.js';

interface AgentCoreEvent {
  type: 'session_start' | 'assistant' | 'result' | 'heartbeat' | 'error';
  provider?: 'codex';
  session_id?: string;
  provider_thread_id?: string;
  provider_turn_id?: string;
  status?: 'in_progress' | 'completed' | 'interrupted' | 'failed';
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  }>;
  model?: string;
  code?: string;
  message?: string;
  duration_ms?: number;
  num_turns?: number;
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    total_cost_usd?: number;
  };
  diff?: string;
  plan?: Array<{ step: string; status: string }>;
}

interface ActiveInvocation {
  controller: AbortController;
  aliases: Set<string>;
}

interface AgentCoreRuntimeDependencies {
  runtimeClient?: any;
  InvokeCommand?: new (input: unknown) => unknown;
  s3Client?: S3Client;
  runtimeArn?: string;
  workspaceBucket?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isPersistedChatSessionId(sessionId: string | undefined): sessionId is string {
  return typeof sessionId === 'string' && UUID_PATTERN.test(sessionId);
}

export class AgentCoreAgentRuntime implements AgentRuntime {
  readonly name = 'agentcore';

  private runtimeClient: any;
  private InvokeCommand: any;
  private sdkLoaded = false;
  private s3Client: S3Client;
  private readonly workspaceBucket: string;
  private activeInvocations = new Set<ActiveInvocation>();
  private invocationAliases = new Map<string, ActiveInvocation>();
  private readonly runtimeArnOverride?: string;

  constructor(dependencies: AgentCoreRuntimeDependencies = {}) {
    this.s3Client = dependencies.s3Client ?? new S3Client({ region: config.aws.region });
    this.workspaceBucket = dependencies.workspaceBucket ?? config.agentcore.workspaceS3Bucket;
    this.runtimeArnOverride = dependencies.runtimeArn;
    if (dependencies.runtimeClient && dependencies.InvokeCommand) {
      this.runtimeClient = dependencies.runtimeClient;
      this.InvokeCommand = dependencies.InvokeCommand;
      this.sdkLoaded = true;
    }
  }

  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;
    try {
      const mod = await import('@aws-sdk/client-bedrock-agentcore' as string);
      // Extract region from the runtime ARN (arn:aws:bedrock-agentcore:{region}:...)
      // to ensure the client targets the correct region regardless of AWS_REGION.
      const arnRegion = config.agentcore.runtimeArn?.split(':')[3];
      const region = arnRegion || config.agentcore.region;
      console.log(
        `[agentcore-runtime] SDK region=${region} (from ARN: ${arnRegion}, config: ${config.agentcore.region})`
      );
      this.runtimeClient = new mod.BedrockAgentCoreClient({ region });
      this.InvokeCommand = mod.InvokeAgentRuntimeCommand;
      this.sdkLoaded = true;
    } catch (err) {
      throw new Error(
        `AgentCore SDK not available. Install @aws-sdk/client-bedrock-agentcore. Error: ${err}`
      );
    }
  }

  private get runtimeArn(): string {
    const arn = this.runtimeArnOverride ?? config.agentcore.runtimeArn;
    if (!arn) throw new Error('AGENTCORE_RUNTIME_ARN is not configured');
    return arn;
  }

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    _skills: SkillForWorkspace[],
    _pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>
  ): AsyncGenerator<ConversationEvent> {
    await this.ensureSDK();
    const chatSessionId = options.sessionId;
    const scopeId = options.scopeId ?? 'default';
    const s3Prefix = `${options.organizationId}/${scopeId}/${chatSessionId ?? 'ephemeral'}/`;
    const [history] = await Promise.all([
      options.history
        ? Promise.resolve(options.history)
        : this.loadChatHistory(options.organizationId, options.sessionId),
      chatSessionId && options.workspacePath
        ? this.uploadWorkspaceIfNeeded(chatSessionId, options.workspacePath, s3Prefix)
        : Promise.resolve(),
    ]);

    const serializableMcpServers = this.serializeMcpServers(mcpServers);
    const backendToken = createToken({
      userId: options.userId,
      email: 'agent-internal@system',
      organizationId: options.organizationId,
      role: 'member',
    });
    const backendUrl = config.agentcore.backendApiUrl || process.env.PUBLIC_API_URL || undefined;
    const model = this.resolveCodexModel(agentConfig);
    if (!model || agentConfig.resolvedModel?.provider === 'litellm') {
      yield {
        type: 'error',
        provider: 'agentcore',
        status: 'failed',
        code: 'AGENTCORE_CODEX_MODEL_UNSUPPORTED',
        message: 'AgentCore Codex requires an OpenAI model available through Amazon Bedrock',
        suggestedAction: 'Select an openai.gpt-* Bedrock model for this scope or agent',
      };
      return;
    }

    const payload = JSON.stringify({
      protocol_version: 2,
      runtime: 'codex',
      prompt: options.message,
      provider_thread_id: options.providerThreadId ?? options.providerSessionId ?? undefined,
      chat_session_id: chatSessionId ?? undefined,
      history: history.length > 0 ? history : undefined,
      scope_id: scopeId,
      org_id: options.organizationId,
      agent_id: options.agentId,
      requested_agent_name: options.requestedAgentName,
      system_prompt: agentConfig.systemPrompt ?? undefined,
      model,
      model_provider: 'amazon-bedrock',
      aws_region: config.agentcore.runtimeArn?.split(':')[3] || config.aws.region,
      reasoning_effort: config.codex.reasoningEffort,
      mcp_servers: serializableMcpServers,
      image_paths: options.imagePaths,
      workspace_s3_bucket: this.workspaceBucket,
      workspace_s3_prefix: s3Prefix,
      backend_api_url: backendUrl,
      backend_api_key: backendToken,
    });

    console.log(`[agentcore-runtime] S3 workspace: s3://${this.workspaceBucket}/${s3Prefix}`);
    console.log(
      `[agentcore-runtime] History count: ${history.length}, workspacePath: ${options.workspacePath ?? 'none'}`
    );

    const rawSessionId = options.sessionId ?? `${options.organizationId}_${options.userId}`;
    const sessionId = rawSessionId.length >= 33 ? rawSessionId : rawSessionId.padEnd(33, '_');
    const commandInput = {
      agentRuntimeArn: this.runtimeArn,
      runtimeSessionId: sessionId,
      payload,
      qualifier: 'DEFAULT',
    };
    const invocation: ActiveInvocation = {
      controller: new AbortController(),
      aliases: new Set([
        rawSessionId,
        sessionId,
        ...(options.providerThreadId ? [options.providerThreadId] : []),
        ...(options.providerSessionId ? [options.providerSessionId] : []),
      ]),
    };
    this.trackInvocation(invocation);

    const MAX_RETRIES = 3;
    const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
    const RETRYABLE_STATUS_CODES = new Set([424, 502, 503, 504]);
    let terminalEvent: ConversationEvent | undefined;
    let postProcessingError: Error | undefined;
    try {
      let response: any;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          response = await this.runtimeClient.send(
            new this.InvokeCommand(commandInput),
            { abortSignal: invocation.controller.signal },
          );
          break;
        } catch (error: any) {
          if (invocation.controller.signal.aborted) {
            terminalEvent = {
              type: 'result',
              provider: 'agentcore',
              status: 'interrupted',
              providerThreadId: options.providerThreadId,
              numTurns: 0,
            };
            break;
          }
          const statusCode = error?.$metadata?.httpStatusCode;
          const retryable = RETRYABLE_STATUS_CODES.has(statusCode);
          if (!retryable || attempt === MAX_RETRIES) {
            terminalEvent = {
              type: 'error',
              provider: 'agentcore',
              status: 'failed',
              code: 'AGENTCORE_INVOKE_ERROR',
              message: `Failed to invoke AgentCore: ${
                error instanceof Error ? error.message : String(error)
              }`,
              suggestedAction: retryable
                ? 'The runtime may be cold-starting; retry in a moment'
                : 'Check AGENTCORE_RUNTIME_ARN and IAM permissions',
            };
            break;
          }
          await new Promise(resolve => setTimeout(
            resolve,
            RETRY_DELAYS_MS[attempt] ?? 10_000,
          ));
        }
      }

      if (response) {
        const contentType: string = response.contentType ?? '';
        if (contentType.includes('text/event-stream')) {
          for await (const event of this.parseSSEStream(response.response)) {
            this.trackProviderAlias(invocation, event.providerThreadId ?? event.sessionId);
            if (event.type === 'result' || event.type === 'error') {
              terminalEvent = event;
            } else {
              yield event;
            }
          }
        } else {
          const body = await this.readBody(response.response);
          try {
            const event = this.mapEvent(JSON.parse(body));
            this.trackProviderAlias(invocation, event.providerThreadId ?? event.sessionId);
            if (event.type === 'result' || event.type === 'error') {
              terminalEvent = event;
            } else {
              yield event;
            }
          } catch {
            terminalEvent = {
              type: 'error',
              provider: 'agentcore',
              status: 'failed',
              code: 'PARSE_ERROR',
              message: `Failed to parse response: ${body.slice(0, 200)}`,
            };
          }
        }
      }
    } finally {
      this.untrackInvocation(invocation);
      if (options.workspacePath && chatSessionId) {
        try {
          await this.syncBackFromS3(s3Prefix, options.workspacePath);
          if (scopeId !== 'default') {
            await this.carryForward(
              options.organizationId,
              scopeId,
              chatSessionId,
            );
          }
        } catch (error) {
          postProcessingError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    if (postProcessingError) {
      yield {
        type: 'error',
        provider: 'agentcore',
        status: 'failed',
        code: 'AGENTCORE_WORKSPACE_FINALIZE_FAILED',
        message: postProcessingError.message,
        suggestedAction: 'Retry after checking workspace S3 and carry-forward access',
      };
      return;
    }
    if (terminalEvent) {
      yield terminalEvent;
      return;
    }
    yield {
      type: 'error',
      provider: 'agentcore',
      status: 'failed',
      code: 'AGENTCORE_MISSING_TERMINAL_EVENT',
      message: 'AgentCore response ended without a terminal result',
    };
  }

  async disconnectSession(sessionId: string): Promise<void> {
    this.invocationAliases.get(sessionId)?.controller.abort();
  }
  async disconnectAll(): Promise<number> {
    const active = [...this.activeInvocations];
    for (const invocation of active) invocation.controller.abort();
    return active.length;
  }
  get activeSessionCount(): number {
    return this.activeInvocations.size;
  }
  hasSession(sessionId: string): boolean {
    return this.invocationAliases.has(sessionId);
  }

  private resolveCodexModel(agentConfig: AgentConfig): string | undefined {
    const candidates = [
      agentConfig.model,
      agentConfig.resolvedModel?.modelId,
      config.codex.model,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && isCodexBedrockModelId(candidate)) {
        return normalizeCodexBedrockModelId(candidate);
      }
    }
    return undefined;
  }

  private serializeMcpServers(
    servers: Record<string, MCPServerSDKConfig> | undefined
  ): Record<string, MCPServerSDKConfig> | undefined {
    if (!servers) return undefined;
    const serializable: Record<string, MCPServerSDKConfig> = {};
    for (const [name, server] of Object.entries(servers)) {
      try {
        JSON.stringify(server);
        serializable[name] = server;
      } catch {
        console.log(`[agentcore-runtime] Skipping non-serializable MCP server: ${name}`);
      }
    }
    return Object.keys(serializable).length > 0 ? serializable : undefined;
  }

  private trackInvocation(invocation: ActiveInvocation): void {
    this.activeInvocations.add(invocation);
    for (const alias of invocation.aliases) {
      this.invocationAliases.set(alias, invocation);
    }
  }

  private trackProviderAlias(
    invocation: ActiveInvocation,
    alias: string | undefined
  ): void {
    if (!alias) return;
    invocation.aliases.add(alias);
    this.invocationAliases.set(alias, invocation);
  }

  private untrackInvocation(invocation: ActiveInvocation): void {
    this.activeInvocations.delete(invocation);
    for (const alias of invocation.aliases) {
      if (this.invocationAliases.get(alias) === invocation) {
        this.invocationAliases.delete(alias);
      }
    }
  }

  private async carryForward(
    organizationId: string,
    scopeId: string,
    sessionId: string
  ): Promise<void> {
    const { carryForwardService } = await import('./carry-forward.service.js');
    const result = await carryForwardService.syncFromSession(
      organizationId,
      scopeId,
      sessionId
    );
    if (
      result.skills.length > 0
      || result.agents.length > 0
      || result.claudeMdUpdated
      || result.settingsUpdated
      || result.hooksUpdated
      || result.systemPromptUpdated
    ) {
      console.log(
        `[agentcore-runtime] Carry-forward complete: `
        + `skills=${result.skills.join(',')}, agents=${result.agents.join(',')}, `
        + `systemPrompt=${result.systemPromptUpdated}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Workspace upload
  // ---------------------------------------------------------------------------

  private async uploadWorkspaceIfNeeded(
    _sessionId: string,
    workspacePath: string,
    s3Prefix: string
  ): Promise<void> {
    const count = await this.uploadDirToS3(workspacePath, s3Prefix);
    console.log(
      `[agentcore-runtime] Mirrored ${count} files to s3://${this.workspaceBucket}/${s3Prefix}`
    );
  }

  // ---------------------------------------------------------------------------
  // Chat history loading
  // ---------------------------------------------------------------------------

  private async loadChatHistory(
    organizationId: string,
    sessionId?: string
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    // Scope generation, skill scanning, workflow generation, and similar
    // system consumers use descriptive ephemeral IDs. The chat table stores
    // UUIDs, so querying those IDs would only create a noisy PostgreSQL error.
    if (!isPersistedChatSessionId(sessionId)) return [];
    try {
      const { prisma } = await import('../config/database.js');
      // Load recent messages, excluding the very latest user message
      // (which is the current prompt — already passed separately in payload.prompt).
      const messages = await prisma.chat_messages.findMany({
        where: { session_id: sessionId, organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: 21, // one extra so we can drop the latest user message
        select: { type: true, content: true },
      });
      const reversed = messages.reverse();
      // Drop the last user message (it's the current prompt being sent)
      let lastUserIdx = -1;
      for (let i = reversed.length - 1; i >= 0; i--) {
        if (reversed[i]!.type === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        reversed.splice(lastUserIdx, 1);
      }
      return reversed.map((m: { type: string; content: string }) => ({
        role: m.type === 'ai' ? ('assistant' as const) : ('user' as const),
        content: this.extractTextFromContent(m.content),
      }));
    } catch (err) {
      console.warn('[agentcore-runtime] Failed to load chat history:', err);
      return [];
    }
  }

  private extractTextFromContent(content: string): string {
    // AI messages are stored as JSON array of content blocks
    try {
      const blocks = JSON.parse(content);
      if (Array.isArray(blocks)) {
        return blocks
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text)
          .join('\n');
      }
    } catch {
      // Not JSON — return as-is (user messages are plain text)
    }
    return content;
  }

  // ---------------------------------------------------------------------------
  // S3 workspace upload
  // ---------------------------------------------------------------------------

  private async uploadDirToS3(localDir: string, s3Prefix: string): Promise<number> {
    let count = 0;
    const SKIP = new Set([
      'node_modules',
      '.git',
      '__pycache__',
      '.venv',
      'venv',
      'env',
      '.env',
      '.tox',
      '.mypy_cache',
      '.pytest_cache',
      '.ruff_cache',
      '.next',
      '.nuxt',
      '.turbo',
      '.cache',
      '.parcel-cache',
      'bower_components',
      '.gradle',
      'target',
      '.cargo',
      // Skip documents directory — RAG uses API calls, not local files.
      // Uploading thousands of document files would be slow and wasteful.
      'documents',
    ]);

    // Phase 1: Collect all files to upload
    const filesToUpload: Array<{ fullPath: string; relPath: string; size: number }> = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isSymbolicLink()) {
          console.warn(`[agentcore-runtime] Skipping workspace symlink: ${relative(localDir, fullPath)}`);
        } else {
          try {
            const fileStat = statSync(fullPath);
            if (fileStat.size > 100 * 1024 * 1024) continue;
            filesToUpload.push({
              fullPath,
              relPath: relative(localDir, fullPath),
              size: fileStat.size,
            });
          } catch {
            /* skip */
          }
        }
      }
    };

    await walk(localDir);

    // Phase 2: Upload in parallel batches (concurrency limit = 10)
    const CONCURRENCY = 10;
    for (let i = 0; i < filesToUpload.length; i += CONCURRENCY) {
      const batch = filesToUpload.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (file) => {
          const key = `${s3Prefix}${file.relPath}`;
          await this.s3Client.send(
            new PutObjectCommand({
              Bucket: this.workspaceBucket,
              Key: key,
              Body: createReadStream(file.fullPath),
              ContentLength: file.size,
            })
          );
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') count++;
        else throw new Error(
          `Workspace upload failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`
        );
      }
    }

    const localPaths = new Set(filesToUpload.map(file => file.relPath));
    const staleKeys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: this.workspaceBucket,
        Prefix: s3Prefix,
        ContinuationToken: continuationToken,
      }));
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        const remotePath = object.Key.slice(s3Prefix.length);
        if (
          remotePath
          && remotePath !== '__diff__.json'
          && !localPaths.has(remotePath)
        ) {
          staleKeys.push(object.Key);
        }
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    for (let i = 0; i < staleKeys.length; i += 1_000) {
      const batch = staleKeys.slice(i, i + 1_000);
      const result = await this.s3Client.send(new DeleteObjectsCommand({
        Bucket: this.workspaceBucket,
        Delete: {
          Quiet: true,
          Objects: batch.map(Key => ({ Key })),
        },
      }));
      if (result.Errors?.length) {
        throw new Error(
          `Workspace deletion failed: ${result.Errors.map(error => error.Key ?? 'unknown').join(', ')}`
        );
      }
    }

    return count;
  }

  // ---------------------------------------------------------------------------
  // S3 → local sync (pull container changes back to local workspace)
  // ---------------------------------------------------------------------------

  /**
   * Sync workspace files from S3 back to local filesystem.
   * Public so that other services (e.g. preview, detect-apps) can ensure
   * the local workspace is up-to-date before operating on it.
   */
  async syncBackFromS3(s3Prefix: string, localDir: string): Promise<number> {
    let downloaded = 0;
    let continuationToken: string | undefined;
    const remotePaths = new Set<string>();
    const SKIP_SEGMENTS = new Set([
      'node_modules',
      '.git',
      '__pycache__',
      '.venv',
      'venv',
      'env',
      '.env',
      '.tox',
      '.mypy_cache',
      '.pytest_cache',
      '.ruff_cache',
      '.next',
      '.nuxt',
      '.turbo',
      '.cache',
      '.parcel-cache',
      'bower_components',
      '.gradle',
      'target',
      '.cargo',
      'documents',
    ]);

    do {
      const result = await this.s3Client.send(
        new ListObjectsV2Command({
          Bucket: this.workspaceBucket,
          Prefix: s3Prefix,
          ContinuationToken: continuationToken,
        })
      );

      for (const obj of result.Contents ?? []) {
        if (!obj.Key) continue;
        const relativePath = obj.Key.slice(s3Prefix.length);
        if (
          !relativePath
          || relativePath.endsWith('/')
          || relativePath === '__diff__.json'
        ) continue;

        const firstSegment = relativePath.split('/')[0];
        if (SKIP_SEGMENTS.has(firstSegment!)) continue;
        remotePaths.add(relativePath);

        try {
          const localPath = await this.prepareWorkspaceDestination(localDir, relativePath);
          const response = await this.s3Client.send(
            new GetObjectCommand({
              Bucket: this.workspaceBucket,
              Key: obj.Key,
            })
          );
          if (response.Body) {
            await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(localPath));
            downloaded++;
          }
        } catch (err) {
          throw new Error(
            `Workspace sync-back failed for ${relativePath}: `
            + `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    const removeStaleFiles = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (SKIP_SEGMENTS.has(entry.name)) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await removeStaleFiles(fullPath);
        } else {
          const relativePath = relative(localDir, fullPath);
          if (!remotePaths.has(relativePath)) {
            await rm(fullPath, { force: true });
          }
        }
      }
    };
    await removeStaleFiles(localDir);

    if (downloaded > 0) {
      console.log(`[agentcore-runtime] Synced back ${downloaded} files from S3 to local`);
    }
    return downloaded;
  }

  private async prepareWorkspaceDestination(
    workspaceRoot: string,
    relativePath: string
  ): Promise<string> {
    const root = resolve(workspaceRoot);
    const candidate = resolve(root, relativePath);
    if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
      throw new Error(`Unsafe workspace path: ${relativePath}`);
    }

    const parentRelative = relative(root, dirname(candidate));
    let current = root;
    for (const segment of parentRelative.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(`Unsafe workspace parent: ${relative(root, current)}`);
        }
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
        await mkdir(current);
      }
    }

    try {
      const entry = await lstat(candidate);
      if (entry.isSymbolicLink() || entry.isDirectory()) {
        throw new Error(`Unsafe workspace destination: ${relativePath}`);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return candidate;
  }

  private async *parseSSEStream(stream: any): AsyncGenerator<ConversationEvent> {
    let buffer = '';
    const iterable = stream[Symbol.asyncIterator]
      ? stream
      : stream.transformToByteArray
        ? [await stream.transformToByteArray()]
        : [stream];

    for await (const chunk of iterable) {
      buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;
          try {
            yield this.mapEvent(JSON.parse(data));
          } catch {
            /* skip */
          }
        }
      }
    }
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        try {
          yield this.mapEvent(JSON.parse(data));
        } catch {
          /* skip */
        }
      }
    }
  }

  private mapEvent(event: AgentCoreEvent): ConversationEvent {
    const base = {
      provider: 'agentcore' as const,
      sessionId: event.session_id,
      providerThreadId: event.provider_thread_id ?? event.session_id,
      providerTurnId: event.provider_turn_id,
      status: event.status,
    };
    switch (event.type) {
      case 'session_start':
        return {
          ...base,
          type: 'session_start',
          status: event.status ?? 'in_progress',
          model: event.model,
        };
      case 'assistant':
        return {
          ...base,
          type: 'assistant',
          status: event.status ?? 'in_progress',
          content: (event.content ?? []) as ContentBlock[],
          model: event.model,
        };
      case 'result': {
        const tu = event.token_usage;
        const tokenUsage = tu
          ? {
              inputTokens: tu.input_tokens ?? 0,
              outputTokens: tu.output_tokens ?? 0,
              cacheReadInputTokens: tu.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: tu.cache_creation_input_tokens ?? 0,
              ...(tu.total_cost_usd !== undefined
                ? { totalCostUsd: tu.total_cost_usd }
                : {}),
            }
          : undefined;
        return {
          ...base,
          type: 'result',
          status: event.status ?? 'completed',
          model: event.model,
          durationMs: event.duration_ms,
          numTurns: event.num_turns,
          tokenUsage,
        };
      }
      case 'heartbeat':
        return {
          ...base,
          type: 'heartbeat',
          status: event.status ?? 'in_progress',
          diff: event.diff,
          plan: event.plan,
        };
      case 'error':
        return {
          ...base,
          type: 'error',
          status: event.status ?? 'failed',
          code: event.code ?? 'AGENTCORE_ERROR',
          message: event.message ?? 'Unknown error',
        };
      default:
        return {
          type: 'error',
          provider: 'agentcore',
          status: 'failed',
          code: 'UNKNOWN_EVENT',
          message: `Unknown event type: ${(event as any).type}`,
        };
    }
  }

  private async readBody(stream: any): Promise<string> {
    if (typeof stream.transformToString === 'function') return stream.transformToString();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }
}
