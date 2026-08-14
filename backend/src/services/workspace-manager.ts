/**
 * Workspace Manager
 * Manages per-session isolated workspace directories using the selected
 * runtime's canonical layout. Codex and AgentCore workspaces use:
 *
 *   {baseDir}/{orgId}/{scopeId}/sessions/{sessionId}/
 *     AGENTS.md
 *     .agents/skills/{name}/SKILL.md
 *     .codex/config.toml
 *     .codex/agents/{name}.toml
 *
 * Supports config-version-based lazy refresh so active sessions pick up
 * scope/agent/skill changes and workspace layout migrations on the next turn.
 */

import { mkdir, rm, readFile, writeFile, access, readdir, stat, cp, symlink } from 'fs/promises';
import { join, relative, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { config } from '../config/index.js';
import { buildCodexSecurityHookScript } from './codex/codex-security-hook.js';
import type { MCPServerSDKConfig } from './agent-types.js';

// Built-in skills directory: backend/skills/
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BUILTIN_SKILLS_DIR = join(__dirname, '..', '..', 'skills');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Skill info needed for workspace setup (camelCase). */
export interface WorkspaceFileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  children?: WorkspaceFileNode[];
}

/** Skill info needed for workspace setup (camelCase). */
export interface SkillForWorkspace {
  id: string;
  name: string;
  hashId: string;
  s3Bucket: string;
  s3Prefix: string;
  /** Local path for marketplace-installed skills (takes precedence over S3) */
  localPath?: string;
  /** Inline skill body for generated skills (fallback when S3 has no content) */
  description?: string;
  body?: string;
}

/** MCP server info needed for workspace settings.json generation. */
export interface McpServerForWorkspace {
  name: string;
  hostAddress: string;
  /** Optional env vars to pass to stdio servers */
  env?: Record<string, string>;
  /** Structured SDK config (takes precedence over hostAddress parsing) */
  config?: Record<string, unknown> | null;
}

/** Plugin info needed for workspace provisioning. */
export interface PluginForWorkspace {
  name: string;
  gitUrl: string;
  ref: string;
}

/** Agent info needed for subagent file generation. */
export interface AgentForWorkspace {
  id: string;
  name: string;
  displayName: string;
  role: string | null;
  systemPrompt: string | null;
  skillNames: string[];
  modelConfig?: Record<string, unknown> | null;
  /** Avatar S3 key or URL (used for speaker annotation in SSE). */
  avatar?: string | null;
  generatedSkills?: Array<{ name: string; description: string; body: string }>;
}

/** Business scope info needed for workspace provisioning. */
export interface ScopeForWorkspace {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  settings?: Record<string, unknown> | null;
  configVersion: number;
  agents: AgentForWorkspace[];
  skills: SkillForWorkspace[];
  mcpServers?: McpServerForWorkspace[];
  plugins?: PluginForWorkspace[];
  documentGroups?: DocGroupForWorkspace[];
}

export interface DocGroupForWorkspace {
  id: string;
  name: string;
  storagePath: string;
  fileCount: number;
}

/** Manifest stored in each session workspace. */
export interface WorkspaceManifest {
  sessionId: string;
  businessScopeId: string;
  configVersion: number;
  agentId: string | null;
  provisionedAt: string;
  lastSyncedAt: string;
  agents: Array<{ id: string; name: string }>;
  skills: Array<{ id: string; name: string; hashId: string }>;
  runtime?: WorkspaceRuntime;
  layoutVersion?: number;
}

export type WorkspaceRuntime = 'claude' | 'codex';

export interface RuntimeWorkspaceLayout {
  instructionsFile: string;
  skillsDir: string;
  agentsDir: string;
  configFile: string;
  hooksFile?: string;
  scopePromptFile: string;
  pluginsDir?: string;
}

export const WORKSPACE_LAYOUTS: Record<WorkspaceRuntime, RuntimeWorkspaceLayout> = {
  claude: {
    instructionsFile: 'CLAUDE.md',
    skillsDir: '.claude/skills',
    agentsDir: '.claude/agents',
    configFile: '.claude/settings.json',
    scopePromptFile: '.claude/scope-system-prompt.md',
    pluginsDir: '.claude/plugins',
  },
  codex: {
    instructionsFile: 'AGENTS.md',
    skillsDir: '.agents/skills',
    agentsDir: '.codex/agents',
    configFile: '.codex/config.toml',
    hooksFile: '.codex/hooks.json',
    scopePromptFile: '.codex/scope-system-prompt.md',
    pluginsDir: '.codex/plugins',
  },
};

const MANIFEST_FILENAME = '.workspace-manifest.json';
const MCP_SERVERS_FILENAME = '.runtime/mcp-servers.json';
const WORKSPACE_LAYOUT_VERSION = 2;

export class WorkspaceManager {
  private readonly baseDir: string;
  private readonly s3Client: S3Client;
  private readonly runtime: WorkspaceRuntime;
  private readonly sessionProvisioning = new Map<
    string,
    Promise<{ workspacePath: string; pluginPaths: string[] }>
  >();

  constructor(baseDir?: string, s3Client?: S3Client, runtime?: WorkspaceRuntime) {
    this.baseDir = baseDir ?? config.claude.workspaceBaseDir;
    this.s3Client = s3Client ?? new S3Client({ region: config.aws.region });
    this.runtime = runtime ?? (
      config.agentRuntime === 'codex' || config.agentRuntime === 'agentcore'
        ? 'codex'
        : 'claude'
    );
  }

  // =========================================================================
  // Path helpers
  // =========================================================================

  /** Per-session workspace: {baseDir}/{orgId}/{scopeId}/sessions/{sessionId}/ */
  getSessionWorkspacePath(orgId: string, scopeId: string, sessionId: string): string {
    return join(this.baseDir, orgId, scopeId, 'sessions', sessionId);
  }

  /** Legacy per-agent workspace path (kept for backward compat). */
  getWorkspacePath(agentId: string): string {
    return join(this.baseDir, agentId);
  }

  getSkillsDir(agentId: string): string {
    return join(this.baseDir, agentId, this.getActiveRuntimeLayout().skillsDir);
  }

  getRuntimeLayout(runtime: WorkspaceRuntime): RuntimeWorkspaceLayout {
    return WORKSPACE_LAYOUTS[runtime];
  }

  getActiveRuntimeLayout(): RuntimeWorkspaceLayout {
    return WORKSPACE_LAYOUTS[this.runtime];
  }

  getActiveRuntimeName(): WorkspaceRuntime {
    return this.runtime;
  }

  // =========================================================================
  // RAG skill helpers
  // =========================================================================

  /**
   * Resolve the backend URL that the agent can use to call back to the API.
   * - In local (claude) mode: localhost
   * - In agentcore/openclaw mode: the configured external backend URL
   */
  private resolveBackendUrl(): string {
    if (config.agentRuntime === 'agentcore' || config.agentRuntime === 'openclaw') {
      // AgentCore containers cannot reach localhost — use the external backend URL
      const externalUrl = config.agentcore.backendApiUrl
        || process.env.PUBLIC_API_URL
        || process.env.API_BASE_URL;
      if (externalUrl) return externalUrl;
      console.warn('[workspace-manager] AgentCore mode but no AGENTCORE_BACKEND_API_URL configured — RAG skill will use localhost (likely broken in container)');
    }
    return `http://localhost:${process.env.PORT || 3001}`;
  }

  /**
   * Build the knowledge-search skill markdown content.
   * Includes auth instructions so the agent can authenticate API calls.
   * Supports both knowledge_base_ids (new) and scope_id (legacy fallback).
   */
  private buildRagSkillContent(backendUrl: string, opts: { knowledgeBaseIds?: string[]; scopeId?: string }): string {
    const isRemote = config.agentRuntime === 'agentcore' || config.agentRuntime === 'openclaw';

    // Determine query parameter
    let queryParam: string;
    if (opts.knowledgeBaseIds && opts.knowledgeBaseIds.length > 0) {
      queryParam = `knowledge_base_ids=${opts.knowledgeBaseIds.join(',')}`;
    } else if (opts.scopeId) {
      queryParam = `scope_id=${opts.scopeId}`;
    } else {
      return ''; // No knowledge source configured
    }

    const lines = [
      '# Knowledge Search',
      '',
      'Use this skill to search the knowledge base for relevant document passages.',
      'This performs semantic similarity search — much more accurate than grep for finding relevant information.',
      '',
      '## When to Use',
      '- User asks about specific policies, procedures, or regulations',
      '- User needs information that might be in uploaded documents',
      '- You need to cite or reference specific document content',
      '- Grep/ripgrep returns too many or irrelevant results',
      '',
      '## How to Use',
      '',
    ];

    if (isRemote) {
      // In AgentCore mode, the agent needs to use curl/fetch with auth header
      lines.push(
        'Run a shell command to call the RAG API:',
        '',
        '```bash',
        `curl -s -H "Authorization: Bearer $AUTH_TOKEN" "${backendUrl}/api/rag/search?${queryParam}&q={URL_ENCODED_QUERY}&top_k=5"`,
        '```',
        '',
        'The `AUTH_TOKEN` environment variable is pre-configured with a valid authentication token.',
        '',
      );
    } else {
      // Local mode — use WebFetch (no auth needed as it goes through localhost)
      lines.push(
        `Use the WebFetch tool to call: ${backendUrl}/api/rag/search?${queryParam}&q={URL_ENCODED_QUERY}&top_k=5`,
        '',
      );
    }

    lines.push(
      '## Response Format',
      'JSON with a `data` array. Each result contains:',
      '- `filename`: source document name',
      '- `content`: relevant text passage (~500 tokens)',
      '- `similarity`: relevance score (0-1, higher is better)',
      '- `chunkIndex`: position within the document',
      '',
      '## Tips',
      '- Use natural language queries, not keywords',
      '- If the first search is not specific enough, refine your query',
      '- Always cite the source filename when using retrieved information',
      '',
    );

    return lines.join('\n');
  }

  // =========================================================================
  // Session workspace provisioning
  // =========================================================================

  /**
   * Provision a brand-new session workspace with all scope artifacts.
   * Called once when a chat session is first created.
   */
  async ensureSessionWorkspace(
    orgId: string,
    sessionId: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    userId?: string,
  ): Promise<{ workspacePath: string; pluginPaths: string[] }> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scope.id, sessionId);
    const inFlight = this.sessionProvisioning.get(workspacePath);
    if (inFlight) {
      return inFlight;
    }

    const provisioning = this.provisionSessionWorkspace(
      workspacePath,
      sessionId,
      scope,
      selectedAgentId,
      orgId,
      userId,
    ).finally(() => {
      if (this.sessionProvisioning.get(workspacePath) === provisioning) {
        this.sessionProvisioning.delete(workspacePath);
      }
    });
    this.sessionProvisioning.set(workspacePath, provisioning);
    return provisioning;
  }

  private async provisionSessionWorkspace(
    workspacePath: string,
    sessionId: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    orgId: string,
    userId?: string,
  ): Promise<{ workspacePath: string; pluginPaths: string[] }> {
    const runtime = this.getActiveRuntimeName();
    const layout = this.getActiveRuntimeLayout();

    // Create directory structure (must complete before parallel writes)
    const skillsDir = join(workspacePath, layout.skillsDir);
    const agentsDir = join(workspacePath, layout.agentsDir);
    await Promise.all([
      mkdir(skillsDir, { recursive: true }),
      mkdir(agentsDir, { recursive: true }),
    ]);

    // --- Phase 1: Run all independent file generation + downloads in parallel ---
    const docGroups = scope.documentGroups ?? [];

    const createDocGroupSymlinks = async () => {
      if (docGroups.length === 0) return;
      const docsDir = join(workspacePath, 'documents');
      await mkdir(docsDir, { recursive: true });
      await Promise.all(docGroups.map(async (group) => {
        const linkName = group.name.replace(/[/\\:*?"<>|]/g, '-');
        const linkPath = join(docsDir, linkName);
        try {
          await symlink(group.storagePath, linkPath);
        } catch (err: any) {
          if (err.code !== 'EEXIST') {
            console.error(`Failed to symlink doc group "${group.name}":`, err.message);
          }
        }
      }));
    };

    const downloadAllSkills = async () => {
      await Promise.all(scope.skills.map(async (skill) => {
        try {
          await this.downloadSkill(skill, skillsDir);
        } catch (error) {
          console.error(`Failed to download skill "${skill.name}" for session ${sessionId}:`, error instanceof Error ? error.message : error);
        }
      }));
    };

    await Promise.all([
      this.generateScopeInstructions(workspacePath, scope, selectedAgentId, userId),
      this.writeScopeSystemPromptFile(workspacePath, scope),
      runtime === 'codex'
        ? this.generateCodexAgentFiles(agentsDir, scope.agents)
        : this.generateAgentSubagentFiles(agentsDir, scope.agents, skillsDir),
      this.generateSettings(workspacePath, scope.mcpServers, scope.settings, scope.agents),
      this.writeMemoryFiles(workspacePath, scope.id, userId),
      createDocGroupSymlinks(),
      downloadAllSkills(),
    ]);

    // --- Phase 2: Things that depend on phase 1 ---
    // Built-in skills must run after S3 downloads (won't overwrite existing)
    const builtinCopied = await this.copyBuiltinSkills(skillsDir);
    if (builtinCopied.length > 0) {
      console.log(`Loaded built-in skills for session ${sessionId}: ${builtinCopied.join(', ')}`);
    }

    // Generate RAG knowledge-search skill if enabled and scope has knowledge bases or document groups
    const { isRagEnabled } = await import('./rag/document-indexer.service.js');
    const { knowledgeBaseService } = await import('./knowledge-base.service.js');
    const kbIds = await knowledgeBaseService.getKnowledgeBaseIdsForScope(scope.id);
    const hasKnowledgeSources = docGroups.length > 0 || kbIds.length > 0;

    if (isRagEnabled() && hasKnowledgeSources) {
      const ragSkillPath = join(skillsDir, 'knowledge-search', 'SKILL.md');
      const backendUrl = this.resolveBackendUrl();
      const ragSkillContent = this.buildRagSkillContent(backendUrl, {
        knowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
        scopeId: kbIds.length === 0 ? scope.id : undefined,
      });
      if (ragSkillContent) {
        await mkdir(dirname(ragSkillPath), { recursive: true });
        await writeFile(ragSkillPath, ragSkillContent, 'utf-8');
      }
    }

    // Install plugins (git clone) — also parallelized internally
    const pluginPaths = await this.installPlugins(workspacePath, scope.plugins ?? []);

    // Inject InsForge app backend MCP configs (if any apps in this scope have backends)
    try {
      const { agentAppDataResolver } = await import('./agent-app-data-resolver.js');
      const injected = await agentAppDataResolver.injectIntoWorkspace(workspacePath, orgId, scope.id);
      if (injected > 0) {
        console.log(`[workspace] Injected ${injected} InsForge app backend MCP config(s) for scope ${scope.id}`);
      }
    } catch (err) {
      console.warn('[workspace] Failed to inject InsForge MCP configs:', err instanceof Error ? err.message : err);
    }

    // Write manifest
    const now = new Date().toISOString();
    await this.writeManifest(workspacePath, {
      sessionId,
      businessScopeId: scope.id,
      configVersion: scope.configVersion,
      agentId: selectedAgentId,
      provisionedAt: now,
      lastSyncedAt: now,
      agents: scope.agents.map(a => ({ id: a.id, name: a.name })),
      skills: scope.skills.map(s => ({ id: s.id, name: s.name, hashId: s.hashId })),
      runtime,
      layoutVersion: WORKSPACE_LAYOUT_VERSION,
    });

    await this.migrateWorkspaceToActiveLayout(workspacePath);
    return { workspacePath, pluginPaths };
  }

  // =========================================================================
  // Lazy refresh (config version check)
  // =========================================================================

  /**
   * Check if the session workspace is up-to-date with the scope's config_version.
   * If stale, refresh the workspace files. Returns true if a refresh happened.
   */
  async ensureWorkspaceUpToDate(
    orgId: string,
    sessionId: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    userId?: string,
  ): Promise<{ refreshed: boolean; pluginPaths: string[] }> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scope.id, sessionId);
    const manifest = await this.readManifest(workspacePath);

    if (!manifest) {
      // No manifest — full provision
      const result = await this.ensureSessionWorkspace(orgId, sessionId, scope, selectedAgentId, userId);
      return { refreshed: true, pluginPaths: result.pluginPaths };
    }

    const layoutCurrent = manifest.runtime === this.runtime
      && manifest.layoutVersion === WORKSPACE_LAYOUT_VERSION;
    if (manifest.configVersion >= scope.configVersion && layoutCurrent) {
      // Already up to date — still resolve plugin paths for the SDK
      const pluginPaths = await this.installPlugins(workspacePath, scope.plugins ?? []);
      return { refreshed: false, pluginPaths };
    }

    // Refresh
    await this.refreshSessionWorkspace(workspacePath, scope, selectedAgentId, manifest, userId);
    const pluginPaths = await this.installPlugins(workspacePath, scope.plugins ?? []);
    return { refreshed: true, pluginPaths };
  }

  /**
   * Targeted refresh: regenerate runtime instructions, agents, skills, and config.
   */
  async refreshSessionWorkspace(
    workspacePath: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    manifest: WorkspaceManifest,
    userId?: string,
  ): Promise<void> {
    const runtime = this.getActiveRuntimeName();
    const layout = this.getActiveRuntimeLayout();

    // Preserve files created in an older Claude-only workspace before replacing
    // the generated layout. Codex-native files win when both already exist.
    await this.migrateLegacyWorkspaceToCodex(workspacePath);

    // 1. Regenerate runtime instructions
    await this.generateScopeInstructions(workspacePath, scope, selectedAgentId, userId);

    // 1a. Refresh scope system prompt file
    await this.writeScopeSystemPromptFile(workspacePath, scope);

    // 1b. Refresh memory files
    await this.writeMemoryFiles(workspacePath, scope.id, userId);

    // 2. Regenerate agent subagent files
    const agentsDir = join(workspacePath, layout.agentsDir);
    await rm(agentsDir, { recursive: true, force: true });
    await mkdir(agentsDir, { recursive: true });
    if (runtime === 'codex') {
      await this.generateCodexAgentFiles(agentsDir, scope.agents);
    } else {
      await this.generateAgentSubagentFiles(agentsDir, scope.agents, join(workspacePath, layout.skillsDir));
    }

    // 3. Diff and sync skills
    await this.syncSkills(workspacePath, manifest.skills, scope.skills);

    // 4. Regenerate settings
    await this.generateSettings(workspacePath, scope.mcpServers, scope.settings, scope.agents);

    // 5. Sync document group symlinks
    const docGroups = scope.documentGroups ?? [];
    const docsDir = join(workspacePath, 'documents');
    if (docGroups.length > 0) {
      await mkdir(docsDir, { recursive: true });

      // Remove stale symlinks for groups no longer assigned
      const desiredNames = new Set(docGroups.map(g => g.name.replace(/[/\\:*?"<>|]/g, '-')));
      try {
        const existing = await readdir(docsDir);
        for (const entry of existing) {
          if (!desiredNames.has(entry)) {
            await rm(join(docsDir, entry), { force: true }).catch(() => {});
          }
        }
      } catch { /* docsDir may not exist yet */ }

      // Create missing symlinks
      for (const group of docGroups) {
        const linkName = group.name.replace(/[/\\:*?"<>|]/g, '-');
        const linkPath = join(docsDir, linkName);
        try {
          await symlink(group.storagePath, linkPath);
        } catch (err: any) {
          if (err.code !== 'EEXIST') {
            console.error(`Failed to symlink doc group "${group.name}":`, err.message);
          }
        }
      }
    } else {
      // No document groups — remove the documents directory if it exists
      await rm(docsDir, { recursive: true, force: true }).catch(() => {});
    }

    // 6. Regenerate RAG knowledge-search skill if applicable
    const skillsDir = join(workspacePath, layout.skillsDir);
    const ragSkillPath = join(skillsDir, 'knowledge-search', 'SKILL.md');
    const { isRagEnabled } = await import('./rag/document-indexer.service.js');
    const { knowledgeBaseService } = await import('./knowledge-base.service.js');
    const kbIds = await knowledgeBaseService.getKnowledgeBaseIdsForScope(scope.id);
    const hasKnowledgeSources = docGroups.length > 0 || kbIds.length > 0;

    if (isRagEnabled() && hasKnowledgeSources) {
      const backendUrl = this.resolveBackendUrl();
      const ragSkillContent = this.buildRagSkillContent(backendUrl, {
        knowledgeBaseIds: kbIds.length > 0 ? kbIds : undefined,
        scopeId: kbIds.length === 0 ? scope.id : undefined,
      });
      if (ragSkillContent) {
        await mkdir(dirname(ragSkillPath), { recursive: true });
        await writeFile(ragSkillPath, ragSkillContent, 'utf-8');
      }
    } else {
      // Remove stale RAG skill if no longer applicable
      await rm(ragSkillPath, { force: true }).catch(() => {});
    }

    // 7. Update manifest
    await this.writeManifest(workspacePath, {
      ...manifest,
      configVersion: scope.configVersion,
      lastSyncedAt: new Date().toISOString(),
      agents: scope.agents.map(a => ({ id: a.id, name: a.name })),
      skills: scope.skills.map(s => ({ id: s.id, name: s.name, hashId: s.hashId })),
      runtime,
      layoutVersion: WORKSPACE_LAYOUT_VERSION,
    });
    await this.migrateWorkspaceToActiveLayout(workspacePath);
  }

  // =========================================================================
  // File generators
  // =========================================================================

  /**
   * Write (or overwrite) the scope system prompt file into the workspace.
   *
   * The agent can edit this file during a session; carry-forward will pick up
   * the change and persist it to `business_scopes.system_prompt`.
   */
  async writeScopeSystemPromptFile(workspacePath: string, scope: ScopeForWorkspace): Promise<void> {
    const body = (scope.systemPrompt ?? '').trim();
    const lines = [
      '---',
      `scopeId: ${scope.id}`,
      `scopeName: ${scope.name}`,
      'title: Scope System Prompt',
      '---',
      '',
      body,
      '',
    ];
    const filePath = join(workspacePath, this.getActiveRuntimeLayout().scopePromptFile);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, lines.join('\n'), 'utf-8');
  }

  /** Generate the selected runtime's root instruction file with scope context. */
  async generateScopeInstructions(
    workspacePath: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    userId?: string,
  ): Promise<void> {
    const runtime = this.getActiveRuntimeName();
    const layout = this.getActiveRuntimeLayout();
    const lines: string[] = [`# ${scope.name}`, ''];
    if (scope.description) {
      lines.push(scope.description, '');
    }

    // Inject scope-level system prompt (behavior instructions for this business domain)
    if (scope.systemPrompt) {
      lines.push('## Scope Instructions', '');
      lines.push(scope.systemPrompt, '');
    }

    // Tell the agent how to evolve the scope system prompt
    lines.push('## Evolving the System Prompt', '');
    lines.push(`The scope-level system prompt is mirrored to \`${layout.scopePromptFile}\` for easy editing.`);
    lines.push('To refine the way this scope operates (role, behavior, defaults), edit that file directly.');
    lines.push(`Changes to \`${layout.scopePromptFile}\` will be carried forward to the scope persistent config after this session.`);
    lines.push('');

    if (scope.agents.length > 0) {
      lines.push('## Available Agents', '');
      lines.push('You have access to specialized subagents for this business scope.');
      lines.push('When the user\'s request matches a specific agent\'s expertise, delegate to that subagent.');
      lines.push('When delegating to a subagent, use the agent\'s technical `name` (the identifier shown in parentheses), not the display name.', '');

      if (selectedAgentId) {
        const selected = scope.agents.find(a => a.id === selectedAgentId);
        if (selected) {
          lines.push(`The user has selected the "${selected.displayName}" agent (name: \`${selected.name}\`). Use this agent's expertise`);
          lines.push('as your primary mode of operation. You may still delegate to other agents if needed.', '');
        }
      }

      for (const agent of scope.agents) {
        lines.push(`- **${agent.displayName}** (name: \`${agent.name}\`): ${agent.role ?? 'General assistant'}`);
      }
      lines.push('');
    }

    lines.push('## Scope Rules', '');
    lines.push(`- Stay within the boundaries of the "${scope.name}" business domain`);
    lines.push('');
    lines.push('## Workspace Security', '');
    lines.push('- You must ONLY read, write, and search files within this workspace directory.');
    lines.push('- NEVER use absolute paths or traverse to parent directories using `..`.');
    lines.push('- NEVER run `find`, `ls`, `cat`, `grep`, or any command targeting paths outside this workspace.');
    lines.push('- All file operations must use relative paths rooted in the current working directory.');
    lines.push(`- The workspace root is: ${workspacePath}`);
    lines.push('- If a user asks to access files outside this workspace, politely decline and explain the restriction.');

    lines.push('');
    lines.push('## Application Code Directory', '');
    lines.push('- All application source code MUST be placed inside the `app/` directory.');
    lines.push(`- The workspace root is reserved for system files (${layout.skillsDir}/, ${dirname(layout.configFile)}/, documents/, memories/).`);
    lines.push('- When creating new projects or features, always use `app/` as the base directory.');
    lines.push('- Example structure: `app/src/`, `app/public/`, `app/package.json`, etc.');

    // Inject document groups (Knowledge Base)
    const docGroups = scope.documentGroups ?? [];
    if (docGroups.length > 0) {
      lines.push('');
      lines.push('## Knowledge Base', '');
      lines.push('Reference documents are available in the `documents/` directory. These are **READ-ONLY**.');
      lines.push('- NEVER modify, delete, or create files inside `documents/`.');
      lines.push('- Use grep or ripgrep to search within these files when you need reference information.');

      // Add RAG instructions if enabled
      const { isRagEnabled: checkRag } = await import('./rag/document-indexer.service.js');
      if (checkRag()) {
        lines.push('- **Preferred**: Use the `knowledge-search` skill for semantic search — it finds relevant passages much more accurately than grep.');
      }

      lines.push('');
      lines.push('Available document groups:');
      for (const g of docGroups) {
        lines.push(`- \`documents/${g.name.replace(/[/\\:*?"<>|]/g, '-')}\` (${g.fileCount} file${g.fileCount !== 1 ? 's' : ''})`);
      }
      lines.push('');
    }

    // Memory — pinned memories inlined for instant recall, others on-demand
    const { scopeMemoryRepository: memRepo } = await import('../repositories/scope-memory.repository.js');
    const pinnedMemories = await memRepo.findForContext(scope.id, userId).then(
      (all) => all.filter((m) => m.is_pinned),
    );

    lines.push('');
    lines.push('## Memory');
    lines.push('');

    // Inline pinned memories so the agent "just knows" critical info
    if (pinnedMemories.length > 0) {
      lines.push('### What you already know (pinned by user)');
      lines.push('');
      for (const m of pinnedMemories) {
        lines.push(`- **${m.title}**: ${m.content}`);
      }
      lines.push('');
      lines.push('The above is ground truth — if it conflicts with other context, trust this.');
      lines.push('');
    }

    lines.push('### Past knowledge (read on demand)');
    lines.push('');
    lines.push('Additional memories from past conversations are in `memories/`:');
    lines.push('');
    lines.push('- `memories/lessons.md` — Mistakes, corrections, and improvements');
    lines.push('- `memories/patterns.md` — Recurring user needs and effective solution paths');
    lines.push('- `memories/gaps.md` — Capability gaps and unresolved requests');
    lines.push('');
    lines.push('On your FIRST response, read `memories/lessons.md` to refresh context.');
    lines.push('Also check `memories/patterns.md` when a task feels familiar, and `memories/gaps.md` when stuck.');
    lines.push('');
    lines.push('These files are managed by the system — do not edit them.');
    lines.push('');

    // Custom section marker — content below this line is preserved across sessions
    // via carry-forward. Agent can add custom rules/instructions below.
    lines.push('<!-- CUSTOM_SECTION: Agent-generated rules below -->');
    lines.push('');

    // Append previously carried custom root-instruction content.
    const scopeSettings = scope.settings as Record<string, unknown> | null;
    const customInstructions = runtime === 'codex'
      ? (scopeSettings?.customAgentsMd ?? scopeSettings?.customClaudeMd)
      : scopeSettings?.customClaudeMd;
    if (typeof customInstructions === 'string' && customInstructions) {
      lines.push(customInstructions);
      lines.push('');
    }

    await writeFile(join(workspacePath, layout.instructionsFile), lines.join('\n'), 'utf-8');
  }

  /**
   * Compatibility entry point for callers that still use the old method name.
   * New code should call generateScopeInstructions().
   */
  async generateScopeClaudeMd(
    workspacePath: string,
    scope: ScopeForWorkspace,
    selectedAgentId: string | null,
    userId?: string,
    runtime?: WorkspaceRuntime,
  ): Promise<void> {
    if (runtime && runtime !== this.runtime) {
      throw new Error(`Cannot generate ${runtime} instructions in a ${this.runtime} workspace`);
    }
    await this.generateScopeInstructions(workspacePath, scope, selectedAgentId, userId);
  }

  /**
   * Write scope memories as separate files in the workspace memories/ directory.
   * Agent reads these on-demand via Read/Grep tools instead of having them
   * inlined in the root instruction file (avoids context window bloat).
   *
   * File layout:
   *   memories/pinned.md   — User-pinned important knowledge (check first)
   *   memories/lessons.md  — Mistakes, corrections, improvements
   *   memories/patterns.md — Recurring needs and effective solutions
   *   memories/gaps.md     — Capability gaps and unresolved requests
   *
   * Visibility: loads scope-level memories + user's own private memories.
   */
  async writeMemoryFiles(workspacePath: string, scopeId: string, userId?: string): Promise<void> {
    const { scopeMemoryRepository } = await import('../repositories/scope-memory.repository.js');
    const memories = await scopeMemoryRepository.findForContext(scopeId, userId);
    if (memories.length === 0) return;

    const memoriesDir = join(workspacePath, 'memories');
    await mkdir(memoriesDir, { recursive: true });

    // Group memories by file target
    const pinned: typeof memories = [];
    const lessons: typeof memories = [];
    const patterns: typeof memories = [];
    const gaps: typeof memories = [];

    for (const m of memories) {
      if (m.is_pinned) {
        pinned.push(m);
      } else if (m.category === 'lesson') {
        lessons.push(m);
      } else if (m.category === 'pattern') {
        patterns.push(m);
      } else if (m.category === 'gap') {
        gaps.push(m);
      } else {
        // Uncategorized goes to lessons as a safe default
        lessons.push(m);
      }
    }

    const formatMemories = (items: typeof memories): string => {
      if (items.length === 0) return '*No entries yet.*\n';
      return items.map(m => {
        const autoLabel = m.tags.includes('auto-distilled') ? ' *(auto)* ' : ' ';
        const date = m.created_at instanceof Date
          ? m.created_at.toISOString().split('T')[0]
          : '';
        return `### ${date}: ${m.title}\n${autoLabel}\n${m.content}\n`;
      }).join('\n');
    };

    await writeFile(
      join(memoriesDir, 'pinned.md'),
      `# Pinned Knowledge\n\nImportant knowledge pinned by the user. Always check before complex work.\n\n${formatMemories(pinned)}`,
      'utf-8',
    );
    await writeFile(
      join(memoriesDir, 'lessons.md'),
      `# Lessons Learned\n\nMistakes, corrections, and improvements from past conversations.\n\n${formatMemories(lessons)}`,
      'utf-8',
    );
    await writeFile(
      join(memoriesDir, 'patterns.md'),
      `# Patterns\n\nRecurring user needs and effective solution paths.\n\n${formatMemories(patterns)}`,
      'utf-8',
    );
    await writeFile(
      join(memoriesDir, 'gaps.md'),
      `# Capability Gaps\n\nKnown limitations and unresolved requests.\n\n${formatMemories(gaps)}`,
      'utf-8',
    );
  }

  /** Generate Claude-compatible Markdown subagent files from DB agents. */
  async generateAgentSubagentFiles(agentsDir: string, agents: AgentForWorkspace[], skillsDir?: string): Promise<void> {
    for (const agent of agents) {
      // Collect all skill names (existing + generated)
      const allSkillNames = [...agent.skillNames];

      // Write generated skills as SKILL.md files
      if (skillsDir && agent.generatedSkills && agent.generatedSkills.length > 0) {
        for (const skill of agent.generatedSkills) {
          const skillDir = join(skillsDir, skill.name);
          await mkdir(skillDir, { recursive: true });
          const skillContent = [
            '---',
            `name: ${skill.name}`,
            `description: ${skill.description}`,
            '---',
            '',
            skill.body,
          ].join('\n');
          await writeFile(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
          if (!allSkillNames.includes(skill.name)) {
            allSkillNames.push(skill.name);
          }
        }
      }

      const lines: string[] = ['---'];
      lines.push(`name: ${agent.name}`);
      lines.push(`description: ${agent.displayName} — ${agent.role ?? 'General assistant'}. Use when the user needs help with ${agent.role ?? 'this domain'}.`);
      lines.push('model: inherit');
      lines.push('permissionMode: bypassPermissions');
      if (allSkillNames.length > 0) {
        lines.push(`skills: ${allSkillNames.join(', ')}`);
      }
      lines.push('---', '');
      if (agent.systemPrompt) {
        lines.push(agent.systemPrompt);
      }

      const filename = `${agent.name}.md`;
      await writeFile(join(agentsDir, filename), lines.join('\n'), 'utf-8');
    }
  }

  /** Generate project-scoped Codex agent role config files from DB agents. */
  async generateCodexAgentFiles(agentsDir: string, agents: AgentForWorkspace[]): Promise<void> {
    await mkdir(agentsDir, { recursive: true });
    for (const agent of agents) {
      const name = safeWorkspaceName(agent.name);
      const description = `${agent.displayName} - ${agent.role ?? 'General assistant'}`;
      const instructions: string[] = [];
      if (agent.systemPrompt) instructions.push(agent.systemPrompt.trim());
      if (agent.skillNames.length > 0) {
        instructions.push(
          `Relevant project skills are available under .agents/skills: ${agent.skillNames.join(', ')}.`,
        );
      }
      const content = [
        `name = ${tomlString(name)}`,
        `description = ${tomlString(description)}`,
        `developer_instructions = ${tomlMultiline(instructions.filter(Boolean).join('\n\n'))}`,
        '',
      ].join('\n');
      await writeFile(join(agentsDir, `${name}.toml`), content, 'utf-8');
    }
  }

  /** Generate the selected runtime's project config with optional MCP servers. */
  async generateSettings(
    workspacePath: string,
    mcpServers?: McpServerForWorkspace[],
    scopeSettings?: Record<string, unknown> | null,
    agents: AgentForWorkspace[] = [],
  ): Promise<void> {
    const settings: Record<string, unknown> = {
      permissions: {
        allow: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Skill', 'WebFetch'],
      },
    };

    const mcpConfig: Record<string, unknown> = {};

    // In agentcore mode, add built-in AgentCore tools (Browser + Code Interpreter).
    //
    // Version is PINNED to 0.1.2, not @latest. Reason: 0.1.1 hardcoded a docs
    // index URL (https://aws.github.io/bedrock-agentcore-starter-toolkit/llms.txt)
    // that now 404s and crashed the MCP server at startup, so no browser/code-
    // interpreter tools ever registered. 0.1.2 (2026-07-28) fixes both the URL
    // and makes the fetch non-fatal. `uvx @latest` can serve a stale cached
    // 0.1.1, so we pin the exact fixed version.
    //
    // Identifiers are passed as env vars — 0.1.2 reads BROWSER_IDENTIFIER /
    // CODE_INTERPRETER_IDENTIFIER (defaulting to the AWS-managed aws.browser.v1 /
    // aws.codeinterpreter.v1 resources when unset). The deploy script injects the
    // real resource ids into the container env; we fall back to the managed
    // defaults so tools still work before any custom resource exists.
    if (config.agentRuntime === 'agentcore') {
      const agentcoreRegion = config.agentcore.runtimeArn?.split(':')[3] || config.aws.region;
      mcpConfig['agentcore-tools'] = {
        type: 'stdio',
        command: 'uvx',
        args: ['awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2'],
        env: {
          AWS_REGION: agentcoreRegion,
          FASTMCP_LOG_LEVEL: 'ERROR',
          BROWSER_IDENTIFIER: process.env.AGENTCORE_BROWSER_IDENTIFIER || 'aws.browser.v1',
          CODE_INTERPRETER_IDENTIFIER: process.env.AGENTCORE_CODE_INTERPRETER_IDENTIFIER || 'aws.codeinterpreter.v1',
        },
      };
    }

    // Write scope-level MCP servers so Claude Code discovers them via project settings
    if (mcpServers && mcpServers.length > 0) {
      for (const server of mcpServers) {
        // Prefer structured config if available
        if (server.config && typeof server.config === 'object') {
          const c = server.config as Record<string, unknown>;
          const type = (c.type as string) || 'stdio';
          if (type === 'sse' || type === 'http') {
            mcpConfig[server.name] = { type, url: c.url };
          } else {
            const entry: Record<string, unknown> = { type: 'stdio', command: c.command };
            if (Array.isArray(c.args)) entry.args = c.args;
            if (c.env && typeof c.env === 'object' && Object.keys(c.env as object).length > 0) entry.env = c.env;
            mcpConfig[server.name] = entry;
          }
          continue;
        }

        // Fallback: parse from hostAddress string
        const address = server.hostAddress?.trim();
        if (!address) continue;
        if (address.startsWith('http://') || address.startsWith('https://')) {
          mcpConfig[server.name] = { type: 'sse', url: address };
        } else {
          const parts = address.split(/\s+/);
          mcpConfig[server.name] = {
            type: 'stdio',
            command: parts[0],
            args: parts.length > 1 ? parts.slice(1) : undefined,
            ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
          };
        }
      }
    }

    if (Object.keys(mcpConfig).length > 0) {
      settings.mcpServers = mcpConfig;
    }

    // Include hooks from scope settings (carried forward from previous sessions)
    if (scopeSettings?.hooks && typeof scopeSettings.hooks === 'object') {
      settings.hooks = scopeSettings.hooks;
    }

    await this.writeCanonicalMcpServers(
      workspacePath,
      mcpConfig as Record<string, MCPServerSDKConfig>,
    );

    if (this.runtime === 'claude') {
      const settingsPath = join(workspacePath, WORKSPACE_LAYOUTS.claude.configFile);
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return;
    }

    const codexLines = [
      '# Generated from platform workspace configuration. Do not add provider or auth keys here.',
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      '',
      '[features]',
      'hooks = true',
      '',
      '[agents]',
      `enabled = ${agents.length > 0 ? 'true' : 'false'}`,
      '',
    ];

    for (const agent of agents) {
      const name = safeWorkspaceName(agent.name);
      codexLines.push(
        `[agents.${tomlKey(name)}]`,
        `description = ${tomlString(`${agent.displayName} - ${agent.role ?? 'General assistant'}`)}`,
        `config_file = ${tomlString(`agents/${name}.toml`)}`,
        '',
      );
    }

    for (const [name, rawConfig] of Object.entries(mcpConfig)) {
      if (!rawConfig || typeof rawConfig !== 'object') continue;
      const mcp = rawConfig as Record<string, unknown>;
      codexLines.push(`[mcp_servers.${tomlKey(name)}]`);
      if (typeof mcp.command === 'string' && mcp.command) {
        codexLines.push(`command = ${tomlString(mcp.command)}`);
        if (Array.isArray(mcp.args)) {
          codexLines.push(`args = ${tomlArray(mcp.args.filter((arg): arg is string => typeof arg === 'string'))}`);
        }
        if (mcp.env && typeof mcp.env === 'object') {
          codexLines.push(`env = ${tomlInlineStringMap(mcp.env as Record<string, unknown>)}`);
        }
      } else if (typeof mcp.url === 'string' && mcp.url) {
        codexLines.push(`url = ${tomlString(mcp.url)}`);
      }
      codexLines.push('required = true', '');
    }

    const codexConfigPath = join(workspacePath, WORKSPACE_LAYOUTS.codex.configFile);
    await mkdir(dirname(codexConfigPath), { recursive: true });
    await writeFile(codexConfigPath, codexLines.join('\n'), 'utf-8');
    await this.generateCodexSecurityHooks(
      workspacePath,
      scopeSettings?.codexHooks && typeof scopeSettings.codexHooks === 'object'
        ? scopeSettings.codexHooks as Record<string, unknown>
        : undefined,
    );
  }

  /**
   * Read provider-neutral MCP configuration for a workspace. New workspaces
   * use the canonical runtime file; Claude settings remain a compatibility
   * fallback for workspaces created before this migration.
   */
  async readWorkspaceMcpServers(
    workspacePath: string,
  ): Promise<Record<string, MCPServerSDKConfig>> {
    try {
      const content = await readFile(join(workspacePath, MCP_SERVERS_FILENAME), 'utf-8');
      const parsed = JSON.parse(content) as unknown;
      if (isMcpServerMap(parsed)) return parsed;
    } catch {
      // Fall through to the legacy Claude settings file.
    }

    try {
      const content = await readFile(
        join(workspacePath, WORKSPACE_LAYOUTS.claude.configFile),
        'utf-8',
      );
      const settings = JSON.parse(content) as Record<string, unknown>;
      return isMcpServerMap(settings.mcpServers) ? settings.mcpServers : {};
    } catch {
      return {};
    }
  }

  async updateWorkspaceMcpServer(
    orgId: string,
    scopeId: string,
    sessionId: string,
    name: string,
    server: MCPServerSDKConfig | null,
  ): Promise<void> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const servers = await this.readWorkspaceMcpServers(workspacePath);
    if (server) servers[name] = server;
    else delete servers[name];
    await this.writeWorkspaceMcpServers(workspacePath, servers);

    if (config.agentRuntime === 'agentcore') {
      await Promise.all([
        this.uploadWorkspaceTextFile(
          orgId,
          scopeId,
          sessionId,
          this.getActiveRuntimeLayout().configFile,
        ),
        this.uploadWorkspaceTextFile(orgId, scopeId, sessionId, MCP_SERVERS_FILENAME),
      ]);
    }
  }

  async writeWorkspaceMcpServers(
    workspacePath: string,
    servers: Record<string, MCPServerSDKConfig>,
  ): Promise<void> {
    if (this.runtime === 'claude') {
      const claudePath = join(workspacePath, WORKSPACE_LAYOUTS.claude.configFile);
      let settings: Record<string, unknown> = {};
      try {
        settings = JSON.parse(await readFile(claudePath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // A missing or invalid config file is rebuilt below.
      }
      settings.mcpServers = servers;
      await mkdir(dirname(claudePath), { recursive: true });
      await writeFile(claudePath, JSON.stringify(settings, null, 2), 'utf-8');
      await this.writeCanonicalMcpServers(workspacePath, servers);
      return;
    }

    const codexPath = join(workspacePath, WORKSPACE_LAYOUTS.codex.configFile);
    let codexConfig = '';
    try {
      codexConfig = await readFile(codexPath, 'utf-8');
    } catch {
      codexConfig = [
        'approval_policy = "never"',
        'sandbox_mode = "workspace-write"',
        '',
        '[features]',
        'hooks = true',
        '',
      ].join('\n');
    }
    const withoutMcp = removeTomlSections(codexConfig, 'mcp_servers.');
    const rendered = renderCodexMcpServers(servers);
    await mkdir(dirname(codexPath), { recursive: true });
    await writeFile(
      codexPath,
      `${withoutMcp.trimEnd()}${rendered ? `\n\n${rendered}` : ''}\n`,
      'utf-8',
    );
    await this.writeCanonicalMcpServers(workspacePath, servers);
  }

  private async writeCanonicalMcpServers(
    workspacePath: string,
    servers: Record<string, MCPServerSDKConfig>,
  ): Promise<void> {
    const canonicalPath = join(workspacePath, MCP_SERVERS_FILENAME);
    await mkdir(dirname(canonicalPath), { recursive: true });
    await writeFile(canonicalPath, JSON.stringify(servers, null, 2), 'utf-8');
  }

  private async uploadWorkspaceTextFile(
    orgId: string,
    scopeId: string,
    sessionId: string,
    relativePath: string,
  ): Promise<void> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const body = await readFile(join(workspacePath, relativePath));
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await this.s3Client.send(new PutObjectCommand({
      Bucket: config.agentcore.workspaceS3Bucket,
      Key: `${orgId}/${scopeId}/${sessionId}/${relativePath}`,
      Body: body,
    }));
  }

  private async generateCodexSecurityHooks(
    workspacePath: string,
    customHooks?: Record<string, unknown>,
  ): Promise<void> {
    const hooksDir = join(workspacePath, '.codex', 'hooks');
    const scriptPath = join(hooksDir, 'security-policy.mjs');
    await mkdir(hooksDir, { recursive: true });
    await writeFile(scriptPath, buildCodexSecurityHookScript(), { encoding: 'utf-8', mode: 0o700 });

    const customHookMap = customHooks?.hooks
      && typeof customHooks.hooks === 'object'
      && !Array.isArray(customHooks.hooks)
      ? customHooks.hooks as Record<string, unknown>
      : {};
    const customPreToolUse = Array.isArray(customHookMap.PreToolUse)
      ? customHookMap.PreToolUse
      : [];
    const hooks = {
      ...customHooks,
      description: 'Platform-enforced workspace security policy.',
      hooks: {
        ...customHookMap,
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: `node ${JSON.stringify(scriptPath)}`,
            timeout: 10,
            statusMessage: 'Checking workspace policy',
          }],
        }, ...customPreToolUse],
      },
    };
    await writeFile(
      join(workspacePath, WORKSPACE_LAYOUTS.codex.hooksFile!),
      JSON.stringify(hooks, null, 2),
      'utf-8',
    );
  }

  private async migrateLegacyWorkspaceToCodex(workspacePath: string): Promise<void> {
    if (this.runtime !== 'codex') return;

    const legacy = WORKSPACE_LAYOUTS.claude;
    const codex = WORKSPACE_LAYOUTS.codex;
    const migrations: Array<[string, string, boolean]> = [
      [legacy.instructionsFile, codex.instructionsFile, false],
      [legacy.scopePromptFile, codex.scopePromptFile, false],
      [legacy.skillsDir, codex.skillsDir, true],
    ];

    for (const [sourceRelative, targetRelative, recursive] of migrations) {
      const source = join(workspacePath, sourceRelative);
      const target = join(workspacePath, targetRelative);
      try {
        await access(source);
        try {
          await access(target);
          if (!recursive) continue;
        } catch {
          // Target does not exist yet.
        }
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, {
          recursive,
          force: false,
          errorOnExist: false,
        });
      } catch {
        // Legacy source does not exist.
      }
    }

    const legacyAgentsDir = join(workspacePath, legacy.agentsDir);
    const codexAgentsDir = join(workspacePath, codex.agentsDir);
    try {
      const entries = await readdir(legacyAgentsDir, { withFileTypes: true });
      await mkdir(codexAgentsDir, { recursive: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const sourcePath = join(legacyAgentsDir, entry.name);
        const source = await readFile(sourcePath, 'utf-8');
        const parsed = parseLegacyAgentMarkdown(source, basename(entry.name, '.md'));
        const name = safeWorkspaceName(parsed.name);
        const targetPath = join(codexAgentsDir, `${name}.toml`);
        try {
          await access(targetPath);
          continue;
        } catch {
          // Convert the legacy definition below.
        }
        await writeFile(
          targetPath,
          [
            `name = ${tomlString(name)}`,
            `description = ${tomlString(parsed.description)}`,
            `developer_instructions = ${tomlMultiline(parsed.instructions)}`,
            '',
          ].join('\n'),
          'utf-8',
        );
      }
    } catch {
      // Legacy agents directory does not exist.
    }
  }

  /**
   * Migrate legacy runtime files, verify their Codex counterparts, then remove
   * the inactive layout. This is safe to call repeatedly.
   */
  async migrateWorkspaceToActiveLayout(workspacePath: string): Promise<boolean> {
    const inactive = this.runtime === 'codex'
      ? WORKSPACE_LAYOUTS.claude
      : WORKSPACE_LAYOUTS.codex;
    let hadInactiveLayout = false;
    for (const relativePath of [
      inactive.instructionsFile,
      dirname(inactive.configFile),
      dirname(inactive.skillsDir),
    ]) {
      try {
        await access(join(workspacePath, relativePath));
        hadInactiveLayout = true;
        break;
      } catch {
        // Keep checking.
      }
    }

    if (this.runtime === 'codex') {
      const servers = await this.readWorkspaceMcpServers(workspacePath);
      await this.migrateLegacyWorkspaceToCodex(workspacePath);
      await this.writeWorkspaceMcpServers(workspacePath, servers);
      await this.ensureCodexAgentDeclarations(workspacePath);
      await this.ensureCodexSecurityHooks(workspacePath);
      await this.verifyCodexMigration(workspacePath);
    }

    await this.removeInactiveRuntimeLayout(workspacePath);
    const manifest = await this.readManifest(workspacePath);
    if (manifest) {
      await this.writeManifest(workspacePath, {
        ...manifest,
        runtime: this.runtime,
        layoutVersion: WORKSPACE_LAYOUT_VERSION,
        lastSyncedAt: new Date().toISOString(),
      });
    }
    return hadInactiveLayout;
  }

  private async ensureCodexAgentDeclarations(workspacePath: string): Promise<void> {
    const layout = WORKSPACE_LAYOUTS.codex;
    const agentsDir = join(workspacePath, layout.agentsDir);
    let entries: string[] = [];
    try {
      entries = (await readdir(agentsDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith('.toml'))
        .map(entry => basename(entry.name, '.toml'));
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const configPath = join(workspacePath, layout.configFile);
    let content = await readFile(configPath, 'utf-8');
    const additions: string[] = [];
    if (!/^\[agents\]\s*$/m.test(content)) {
      additions.push('[agents]', 'enabled = true', '');
    } else {
      content = content.replace(
        /^(\[agents\]\s*\n)(enabled\s*=\s*)false\b/m,
        '$1$2true',
      );
    }
    for (const name of entries) {
      const section = `[agents.${tomlKey(name)}]`;
      if (content.includes(section)) continue;
      additions.push(
        section,
        `description = ${tomlString(`Workspace agent ${name}`)}`,
        `config_file = ${tomlString(`agents/${name}.toml`)}`,
        '',
      );
    }
    if (additions.length > 0) {
      content = `${content.trimEnd()}\n\n${additions.join('\n').trimEnd()}\n`;
      await writeFile(configPath, content, 'utf-8');
    }
  }

  private async ensureCodexSecurityHooks(workspacePath: string): Promise<void> {
    const hooksFile = WORKSPACE_LAYOUTS.codex.hooksFile;
    if (!hooksFile) return;
    try {
      await Promise.all([
        access(join(workspacePath, hooksFile)),
        access(join(workspacePath, '.codex', 'hooks', 'security-policy.mjs')),
      ]);
    } catch {
      await this.generateCodexSecurityHooks(workspacePath);
    }
  }

  private async verifyCodexMigration(workspacePath: string): Promise<void> {
    const legacy = WORKSPACE_LAYOUTS.claude;
    const codex = WORKSPACE_LAYOUTS.codex;

    try {
      await access(join(workspacePath, legacy.instructionsFile));
      await access(join(workspacePath, codex.instructionsFile));
    } catch (error) {
      try {
        await access(join(workspacePath, legacy.instructionsFile));
      } catch {
        return;
      }
      throw new Error(`Cannot remove ${legacy.instructionsFile}: ${codex.instructionsFile} was not created`, {
        cause: error,
      });
    }

    const legacySkillFiles = await listRelativeFiles(join(workspacePath, legacy.skillsDir));
    const codexSkillFiles = new Set(await listRelativeFiles(join(workspacePath, codex.skillsDir)));
    const missingSkills = legacySkillFiles.filter(file => !codexSkillFiles.has(file));
    if (missingSkills.length > 0) {
      throw new Error(`Cannot remove ${legacy.skillsDir}: ${missingSkills.length} file(s) were not migrated`);
    }

    const legacyAgentFiles = (await listRelativeFiles(join(workspacePath, legacy.agentsDir)))
      .filter(file => file.endsWith('.md'));
    for (const file of legacyAgentFiles) {
      const expected = `${safeWorkspaceName(basename(file, '.md'))}.toml`;
      try {
        await access(join(workspacePath, codex.agentsDir, expected));
      } catch {
        throw new Error(`Cannot remove ${legacy.agentsDir}: missing ${codex.agentsDir}/${expected}`);
      }
    }
  }

  private async removeInactiveRuntimeLayout(workspacePath: string): Promise<void> {
    const inactive = this.runtime === 'codex'
      ? WORKSPACE_LAYOUTS.claude
      : WORKSPACE_LAYOUTS.codex;
    const paths = new Set([
      inactive.instructionsFile,
      dirname(inactive.skillsDir),
      dirname(inactive.configFile),
    ]);
    await Promise.all(
      [...paths].map(relativePath =>
        rm(join(workspacePath, relativePath), { recursive: true, force: true }),
      ),
    );
  }

  // =========================================================================
  // Skill sync
  // =========================================================================

  /** Diff old vs new skills and only download changed/new ones. */
  async syncSkills(
    workspacePath: string,
    oldSkills: Array<{ id: string; name: string; hashId: string }>,
    newSkills: SkillForWorkspace[],
  ): Promise<void> {
    const oldMap = new Map(oldSkills.map(s => [s.id, s]));
    const newMap = new Map(newSkills.map(s => [s.id, s]));
    const skillsDir = join(workspacePath, this.getActiveRuntimeLayout().skillsDir);

    // Remove deleted skills
    for (const [id, old] of oldMap) {
      if (!newMap.has(id)) {
        await rm(join(skillsDir, old.name), { recursive: true, force: true });
      }
    }

    // Add new or updated skills (hash changed)
    for (const [id, skill] of newMap) {
      const old = oldMap.get(id);
      if (!old || old.hashId !== skill.hashId) {
        try {
          await this.downloadSkill(skill, skillsDir);
        } catch (error) {
          console.error(`Failed to sync skill "${skill.name}":`, error instanceof Error ? error.message : error);
        }
      }
    }
  }

  // =========================================================================
  // Built-in skill loading (local filesystem)
  // =========================================================================

  /**
   * Copy all built-in skills from the local skills/ directory into the
   * workspace's active skills folder. Skips skills that already exist
   * (S3-downloaded skills take precedence by name).
   */
  async copyBuiltinSkills(skillsDir: string): Promise<string[]> {
    const copied: string[] = [];
    try {
      await access(BUILTIN_SKILLS_DIR);
      const entries = await readdir(BUILTIN_SKILLS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const targetDir = join(skillsDir, entry.name);
        try {
          await access(targetDir);
          // Already exists (e.g. downloaded from S3) — skip
          continue;
        } catch {
          // Doesn't exist — copy it
        }
        await cp(join(BUILTIN_SKILLS_DIR, entry.name), targetDir, { recursive: true });
        copied.push(entry.name);
      }
    } catch (error) {
      console.warn('Could not load built-in skills:', error instanceof Error ? error.message : error);
    }
    return copied;
  }

  // =========================================================================
  // Plugin installation (git clone into workspace)
  // =========================================================================

  /**
   * Install plugins into the selected runtime's project plugin directory.
   * Claude receives the cloned paths through its SDK. Codex repositories must
   * contain a valid .codex-plugin/plugin.json manifest to be usable as plugins.
   */
  async installPlugins(workspacePath: string, plugins: PluginForWorkspace[]): Promise<string[]> {
    if (!plugins || plugins.length === 0) return [];
    const pluginsDir = join(
      workspacePath,
      this.getActiveRuntimeLayout().pluginsDir ?? '.runtime/plugins',
    );
    await mkdir(pluginsDir, { recursive: true });

    const results = await Promise.all(plugins.map(async (plugin) => {
      const targetDir = join(pluginsDir, plugin.name);
      try {
        // Skip if already cloned
        await access(targetDir);
        return targetDir;
      } catch { /* not yet cloned */ }

      try {
        const { execFile } = await import('child_process');
        const { promisify } = await import('util');
        const execFileAsync = promisify(execFile);
        await execFileAsync('git', [
          'clone', '--depth', '1', '--branch', plugin.ref,
          plugin.gitUrl, targetDir,
        ], { timeout: 60_000 });
        console.log(`[installPlugins] Cloned plugin "${plugin.name}" from ${plugin.gitUrl}@${plugin.ref}`);
        return targetDir;
      } catch (error) {
        console.error(`[installPlugins] Failed to clone plugin "${plugin.name}":`, error instanceof Error ? error.message : error);
        return null;
      }
    }));

    return results.filter((p): p is string => p !== null);
  }

  // =========================================================================
  // S3 skill download (preserved from original)
  // =========================================================================

  async downloadSkill(skill: SkillForWorkspace, targetDir: string): Promise<boolean> {
    const skillDir = join(targetDir, skill.name);
    
    // Check for local path first (marketplace-installed skills)
    if (skill.localPath) {
      try {
        await access(skill.localPath);
        await mkdir(skillDir, { recursive: true });
        await cp(skill.localPath, skillDir, { recursive: true });
        console.log(`[downloadSkill] Copied local skill "${skill.name}" from ${skill.localPath}`);
        return true;
      } catch (error) {
        console.warn(`[downloadSkill] Local path not accessible for "${skill.name}": ${skill.localPath}, falling back to S3`);
      }
    }
    
    // Fall back to S3 download
    const s3Key = `${skill.s3Prefix}skill.zip`;
    try {
      const response = await this.s3Client.send(new GetObjectCommand({ Bucket: skill.s3Bucket, Key: s3Key }));
      if (!response.Body) {
        console.error(`Empty response body for skill "${skill.name}" from s3://${skill.s3Bucket}/${s3Key}`);
        // Fall through to inline body fallback
      } else {
        await mkdir(skillDir, { recursive: true });

        const zipPath = join(skillDir, 'skill.zip');
        const bodyStream = response.Body as Readable;
        const writeStream = createWriteStream(zipPath);
        await pipeline(bodyStream, writeStream);

        await this.extractSkillZip(zipPath, skillDir);

        try { await rm(zipPath, { force: true }); } catch { /* non-critical */ }
        return true;
      }
    } catch (error) {
      // S3 failed — fall through to inline body fallback
      if (!skill.body && !skill.description) {
        console.error(`S3 download failed for skill "${skill.name}" from s3://${skill.s3Bucket}/${s3Key}:`, error instanceof Error ? error.message : error);
      }
    }

    // Fallback: write inline body as SKILL.md (for scope-generator created skills)
    if (skill.body) {
      await mkdir(skillDir, { recursive: true });
      const content = [
        '---',
        `name: ${skill.name}`,
        ...(skill.description ? [`description: ${skill.description}`] : []),
        '---',
        '',
        skill.body,
      ].join('\n');
      await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');
      console.log(`[downloadSkill] Wrote inline skill "${skill.name}" from metadata body`);
      return true;
    }

    // Last resort: write a minimal SKILL.md with just name and description
    // so the skill is still visible in the workspace even without full content
    if (skill.description) {
      await mkdir(skillDir, { recursive: true });
      const content = [
        '---',
        `name: ${skill.name}`,
        `description: ${skill.description}`,
        '---',
        '',
        `# ${skill.name}`,
        '',
        skill.description,
      ].join('\n');
      await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8');
      console.log(`[downloadSkill] Wrote minimal skill "${skill.name}" from description`);
      return true;
    }

    return false;
  }

  private async extractSkillZip(zipPath: string, targetDir: string): Promise<void> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('unzip', ['-o', zipPath, '-d', targetDir]);
    } catch {
      try {
        await execFileAsync('python3', ['-m', 'zipfile', '-e', zipPath, targetDir]);
      } catch {
        console.warn(`Could not extract ${zipPath}: no unzip utility available`);
        throw new Error('Failed to extract skill archive: no extraction utility available');
      }
    }
  }

  // =========================================================================
  // Legacy workspace support (for backward compat with old per-agent flow)
  // =========================================================================

  async ensureWorkspace(agentId: string, skills: SkillForWorkspace[]): Promise<string> {
    const workspacePath = this.getWorkspacePath(agentId);
    const skillsDir = join(workspacePath, this.getActiveRuntimeLayout().skillsDir);

    // Check if workspace can be reused via manifest
    if (await this.canReuseAgentWorkspace(agentId, skills)) {
      await this.migrateWorkspaceToActiveLayout(workspacePath);
      return workspacePath;
    }

    await mkdir(skillsDir, { recursive: true });
    for (const skill of skills) {
      try { await this.downloadSkill(skill, skillsDir); } catch (error) {
        console.error(`Failed to download skill "${skill.name}" for agent ${agentId}:`, error instanceof Error ? error.message : error);
      }
    }
    await this.copyBuiltinSkills(skillsDir);
    await this.migrateWorkspaceToActiveLayout(workspacePath);

    // Write legacy manifest for reuse checks
    await this.writeLegacyManifest(agentId, skills);

    return workspacePath;
  }

  private async canReuseAgentWorkspace(agentId: string, skills: SkillForWorkspace[]): Promise<boolean> {
    try {
      const manifestPath = join(this.getWorkspacePath(agentId), MANIFEST_FILENAME);
      await access(manifestPath);
      const content = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as { agentId: string; skills: Array<{ id: string; hashId: string }> };
      if (!manifest) return false;

      const currentSet = skills.map(s => `${s.id}:${s.hashId}`).sort().join(',');
      const manifestSet = manifest.skills.map((s: { id: string; hashId: string }) => `${s.id}:${s.hashId}`).sort().join(',');
      
      if (currentSet !== manifestSet) return false;
      
      // Also verify skills actually exist on disk
      const skillsDir = join(this.getWorkspacePath(agentId), this.getActiveRuntimeLayout().skillsDir);
      for (const skill of skills) {
        const skillDir = join(skillsDir, skill.name);
        try {
          await access(skillDir);
        } catch {
          console.log(`[canReuseAgentWorkspace] Skill "${skill.name}" not found on disk, will re-provision`);
          return false;
        }
      }
      
      return true;
    } catch {
      return false;
    }
  }

  private async writeLegacyManifest(agentId: string, skills: SkillForWorkspace[]): Promise<void> {
    const manifestPath = join(this.getWorkspacePath(agentId), MANIFEST_FILENAME);
    const now = new Date().toISOString();
    const manifest = {
      agentId,
      skills: skills.map(s => ({ id: s.id, hashId: s.hashId })),
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  async deleteWorkspace(agentId: string): Promise<void> {
    const workspacePath = this.getWorkspacePath(agentId);
    try { await rm(workspacePath, { recursive: true, force: true }); } catch (error) {
      console.error(`Failed to delete workspace for agent ${agentId}:`, error instanceof Error ? error.message : error);
    }
  }

  // =========================================================================
  // Manifest I/O
  // =========================================================================

  async readManifest(workspacePath: string): Promise<WorkspaceManifest | null> {
    const manifestPath = join(workspacePath, MANIFEST_FILENAME);
    try {
      await access(manifestPath);
      const content = await readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as WorkspaceManifest;
    } catch {
      return null;
    }
  }

  async writeManifest(workspacePath: string, manifest: WorkspaceManifest): Promise<void> {
    await writeFile(join(workspacePath, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf-8');
  }

  /**
   * Ensure the local workspace is up-to-date with S3 (agentcore mode).
   * Downloads all files from S3 to the local workspace directory.
   * This is needed before operations that require local filesystem access
   * (e.g. dev server preview, app detection) because the agentcore container
   * writes files to S3 and the sync-back to local is fire-and-forget.
   *
   * Returns the number of files downloaded.
   */
  async ensureS3SyncedToLocal(
    orgId: string,
    scopeId: string,
    sessionId: string,
  ): Promise<number> {
    const s3Bucket = config.agentcore.workspaceS3Bucket;
    const prefix = `${orgId}/${scopeId}/${sessionId}/`;
    const localDir = this.getSessionWorkspacePath(orgId, scopeId, sessionId);

    let downloaded = 0;
    let continuationToken: string | undefined;

    do {
      const result = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: s3Bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of result.Contents ?? []) {
        if (!obj.Key) continue;
        const relativePath = obj.Key.slice(prefix.length);
        if (!relativePath || relativePath.endsWith('/')) continue;

        // Skip directories that should not be synced to local
        // (node_modules, .git, etc. — same as upload skip list)
        const firstSegment = relativePath.split('/')[0];
        const SKIP_SEGMENTS = new Set([
          'node_modules', '.git', '__pycache__',
          '.venv', 'venv', 'env', '.env',
          '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
          '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
          'bower_components', '.gradle', 'target', '.cargo',
        ]);
        if (SKIP_SEGMENTS.has(firstSegment!)) continue;

        const localPath = join(localDir, relativePath);
        const localDirPath = dirname(localPath);

        try {
          await mkdir(localDirPath, { recursive: true });
          // Skip if localPath is already a directory
          try {
            const s = await stat(localPath);
            if (s.isDirectory()) continue;
          } catch { /* doesn't exist yet, fine */ }
          const response = await this.s3Client.send(new GetObjectCommand({
            Bucket: s3Bucket,
            Key: obj.Key,
          }));
          if (response.Body) {
            await pipeline(
              response.Body as NodeJS.ReadableStream,
              createWriteStream(localPath),
            );
            downloaded++;
          }
        } catch (err) {
          console.warn(`[workspace-manager] ensureS3SyncedToLocal failed for ${relativePath}:`, err instanceof Error ? err.message : err);
        }
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);

    if (downloaded > 0) {
      console.log(`[workspace-manager] Synced ${downloaded} files from S3 to local for session ${sessionId}`);
    }
    return downloaded;
  }

  /**
   * List files in a session workspace as a tree structure.
   * Returns null if the workspace doesn't exist.
   */
  async listWorkspaceFiles(
    orgId: string,
    scopeId: string,
    sessionId: string,
  ): Promise<WorkspaceFileNode[] | null> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    try {
      await access(workspacePath);
    } catch {
      return null;
    }
    return this.readDirRecursive(workspacePath, workspacePath);
  }

  /**
   * List workspace files from S3 (for agentcore mode where files live in the container).
   * Builds a tree from S3 object keys under the workspace prefix.
   */
  async listWorkspaceFilesFromS3(
    orgId: string,
    scopeId: string,
    sessionId: string,
    bucket?: string,
  ): Promise<WorkspaceFileNode[] | null> {
    const s3Bucket = bucket ?? config.agentcore.workspaceS3Bucket;
    const prefix = `${orgId}/${scopeId}/${sessionId}/`;

    try {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const allKeys: Array<{ key: string; size: number }> = [];
      let continuationToken: string | undefined;

      do {
        const result = await this.s3Client.send(new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        for (const obj of result.Contents ?? []) {
          if (obj.Key) {
            const relKey = obj.Key.slice(prefix.length);
            if (relKey) allKeys.push({ key: relKey, size: obj.Size ?? 0 });
          }
        }
        continuationToken = result.NextContinuationToken;
      } while (continuationToken);

      if (allKeys.length === 0) return null;

      // Build tree from flat key list
      return this.buildTreeFromKeys(allKeys);
    } catch (err) {
      console.warn('[workspace-manager] Failed to list S3 workspace:', err);
      return null;
    }
  }

  private buildTreeFromKeys(keys: Array<{ key: string; size: number }>): WorkspaceFileNode[] {
    const root: Map<string, any> = new Map();

    for (const { key, size } of keys) {
      const parts = key.split('/');
      let current = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        if (i === parts.length - 1) {
          // File
          current.set(part, { type: 'file', size });
        } else {
          // Directory
          if (!current.has(part)) {
            current.set(part, new Map());
          }
          current = current.get(part);
        }
      }
    }

    const mapToNodes = (map: Map<string, any>, parentPath: string): WorkspaceFileNode[] => {
      const nodes: WorkspaceFileNode[] = [];
      const entries = [...map.entries()].sort(([aName, aVal], [bName, bVal]) => {
        const aIsDir = aVal instanceof Map;
        const bIsDir = bVal instanceof Map;
        if (aIsDir && !bIsDir) return -1;
        if (!aIsDir && bIsDir) return 1;
        return aName.localeCompare(bName);
      });

      for (const [name, value] of entries) {
        const path = parentPath ? `${parentPath}/${name}` : name;
        if (value instanceof Map) {
          nodes.push({ name, path, type: 'directory', children: mapToNodes(value, path) });
        } else {
          nodes.push({ name, path, type: 'file', size: value.size });
        }
      }
      return nodes;
    };

    return mapToNodes(root, '');
  }

  /**
   * Copy a marketplace-installed skill into a session workspace.
   */
  async installSkillToWorkspace(
    orgId: string,
    scopeId: string,
    sessionId: string,
    skillName: string,
    sourcePath: string,
  ): Promise<void> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const layout = this.getActiveRuntimeLayout();
    const skillsDir = join(workspacePath, layout.skillsDir);
    await mkdir(skillsDir, { recursive: true });
    const targetDir = join(skillsDir, skillName);
    await cp(sourcePath, targetDir, { recursive: true });
  }

  /**
   * List skills installed in a session workspace.
   * Reads the selected runtime's skills directory and returns metadata.
   */
  async listWorkspaceSkills(
    orgId: string,
    scopeId: string,
    sessionId: string,
  ): Promise<Array<{ name: string; hasSkillMd: boolean; description: string | null }>> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const skillsDir = join(workspacePath, this.getActiveRuntimeLayout().skillsDir);
    try {
      await access(skillsDir);
    } catch {
      return [];
    }
    const entries = await readdir(skillsDir, { withFileTypes: true });
    const skills: Array<{ name: string; hasSkillMd: boolean; description: string | null }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let hasSkillMd = false;
      let description: string | null = null;
      try {
        const content = await readFile(join(skillsDir, entry.name, 'SKILL.md'), 'utf-8');
        hasSkillMd = true;
        // Try to extract description from first non-heading, non-empty line
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
          description = trimmed.length > 120 ? trimmed.substring(0, 120) + '…' : trimmed;
          break;
        }
      } catch { /* no SKILL.md */ }
      skills.push({ name: entry.name, hasSkillMd, description });
    }
    return skills;
  }

  /**
   * Delete a skill folder from a session workspace.
   * Returns true if deleted, false if not found.
   */
  async deleteWorkspaceSkill(
    orgId: string,
    scopeId: string,
    sessionId: string,
    skillName: string,
  ): Promise<boolean> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const layout = this.getActiveRuntimeLayout();
    const skillsRoot = join(workspacePath, layout.skillsDir);
    const skillDir = join(skillsRoot, skillName);
    // Prevent path traversal
    if (!skillDir.startsWith(skillsRoot)) return false;
    try {
      await access(skillDir);
      await rm(skillDir, { recursive: true, force: true });

      // In agentcore mode, also delete from S3
      if (config.agentRuntime === 'agentcore') {
        await this.deleteS3Prefix(
          `${orgId}/${scopeId}/${sessionId}/${layout.skillsDir}/${skillName}/`,
        ).catch(err => console.warn('[workspace-manager] S3 delete failed:', err));
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete all S3 objects under a prefix.
   */
  private async deleteS3Prefix(prefix: string): Promise<void> {
    const { ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
    const bucket = config.agentcore.workspaceS3Bucket;
    let continuationToken: string | undefined;

    do {
      const result = await this.s3Client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      const objects = (result.Contents ?? [])
        .filter((obj): obj is { Key: string } => !!obj.Key)
        .map(obj => ({ Key: obj.Key }));

      if (objects.length > 0) {
        await this.s3Client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        }));
      }

      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
  }

  /**
   * Read a single file from a session workspace. Returns null if not found.
   */
  async readWorkspaceFile(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
  ): Promise<string | null> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    // Prevent path traversal
    const resolved = join(workspacePath, filePath);
    if (!resolved.startsWith(workspacePath)) return null;
    try {
      // stat follows symlinks — check if target is a directory
      const fileStat = await stat(resolved);
      if (fileStat.isDirectory()) {
        // Return a listing of the directory contents
        const entries = await readdir(resolved);
        return entries.join('\n');
      }
      return await readFile(resolved, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Read a workspace file from S3 (fallback for agentcore mode when
   * the file only exists in the container and was synced to S3).
   */
  async readWorkspaceFileFromS3(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
  ): Promise<string | null> {
    const s3Bucket = config.agentcore.workspaceS3Bucket;
    const key = `${orgId}/${scopeId}/${sessionId}/${filePath}`;
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      }));
      if (response.Body && typeof (response.Body as any).transformToString === 'function') {
        return await (response.Body as any).transformToString();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read a workspace file from S3 as raw binary Buffer.
   * Used for binary files (images, xlsx, etc.) that cannot be safely converted to UTF-8 strings.
   */
  async readWorkspaceFileFromS3Raw(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
  ): Promise<Buffer | null> {
    const s3Bucket = config.agentcore.workspaceS3Bucket;
    const key = `${orgId}/${scopeId}/${sessionId}/${filePath}`;
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const response = await this.s3Client.send(new GetObjectCommand({
        Bucket: s3Bucket,
        Key: key,
      }));
      if (response.Body && typeof (response.Body as any).transformToByteArray === 'function') {
        const bytes = await (response.Body as any).transformToByteArray();
        return Buffer.from(bytes);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Resolve a workspace-relative file path to an absolute path, with traversal protection. Returns null if invalid. */
  resolveWorkspaceFilePath(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
  ): string | null {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const resolved = join(workspacePath, filePath);
    if (!resolved.startsWith(workspacePath)) return null;
    return resolved;
  }


  async writeWorkspaceFile(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
    content: string,
  ): Promise<boolean> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const resolved = join(workspacePath, filePath);
    if (!resolved.startsWith(workspacePath)) return false;
    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf-8');

      // In agentcore mode, also upload to S3 so the container picks it up
      if (config.agentRuntime === 'agentcore') {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const key = `${orgId}/${scopeId}/${sessionId}/${filePath}`;
        await this.s3Client.send(new PutObjectCommand({
          Bucket: config.agentcore.workspaceS3Bucket,
          Key: key,
          Body: content,
        })).catch(err => console.warn('[workspace-manager] S3 upload failed:', err));
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write raw binary data (Buffer) to a workspace file.
   * Unlike writeWorkspaceFile, this does NOT apply UTF-8 encoding,
   * so binary files (images, PDFs, etc.) are preserved correctly.
   */
  async writeWorkspaceFileRaw(
    orgId: string,
    scopeId: string,
    sessionId: string,
    filePath: string,
    content: Buffer,
  ): Promise<boolean> {
    const workspacePath = this.getSessionWorkspacePath(orgId, scopeId, sessionId);
    const resolved = join(workspacePath, filePath);
    if (!resolved.startsWith(workspacePath)) return false;
    try {
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content);

      // In agentcore mode, also upload to S3 so the container picks it up
      if (config.agentRuntime === 'agentcore') {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        const key = `${orgId}/${scopeId}/${sessionId}/${filePath}`;
        await this.s3Client.send(new PutObjectCommand({
          Bucket: config.agentcore.workspaceS3Bucket,
          Key: key,
          Body: content,
        })).catch(err => console.warn('[workspace-manager] S3 upload failed:', err));

        // Notify the running container to pull the file from S3.
        // Fire-and-forget: don't block the upload response if the container
        // is not running or the sync fails (file is already in S3 and will
        // be picked up on next invocation).
        import('./agentcore-command.service.js').then(({ agentCoreCommandService }) => {
          agentCoreCommandService.syncFileFromS3(
            sessionId,
            config.agentcore.workspaceS3Bucket,
            key,
            filePath,
          ).catch(err => console.warn('[workspace-manager] Container sync failed (non-fatal):', err instanceof Error ? err.message : err));
        });
      }

      return true;
    } catch {
      return false;
    }
  }


  /** Directories to show in the tree but NOT recurse into (too large / not useful). */
  private static readonly SHALLOW_DIRS = new Set([
    'node_modules', '.git', '.next', '.nuxt', '.cache', 'dist', 'build',
    '__pycache__', '.venv', 'venv', '.tox',
  ]);

  private async readDirRecursive(dir: string, rootDir: string): Promise<WorkspaceFileNode[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nodes: WorkspaceFileNode[] = [];

    // Resolve whether each entry is a directory, following symlinks
    const resolvedEntries: Array<{ entry: import('fs').Dirent; isDir: boolean }> = [];
    for (const entry of entries) {
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          const targetStat = await stat(join(dir, entry.name)); // stat follows symlinks
          isDir = targetStat.isDirectory();
        } catch {
          // Broken symlink — treat as file
          isDir = false;
        }
      }
      resolvedEntries.push({ entry, isDir });
    }

    resolvedEntries.sort((a, b) => {
      // Directories first, then alphabetical
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.entry.name.localeCompare(b.entry.name);
    });

    for (const { entry, isDir } of resolvedEntries) {
      const fullPath = join(dir, entry.name);
      const relativePath = relative(rootDir, fullPath);
      if (isDir) {
        if (WorkspaceManager.SHALLOW_DIRS.has(entry.name)) {
          nodes.push({ name: entry.name, path: relativePath, type: 'directory', children: [] });
        } else {
          try {
            const children = await this.readDirRecursive(fullPath, rootDir);
            nodes.push({ name: entry.name, path: relativePath, type: 'directory', children });
          } catch {
            // Directory may have been removed or is a broken symlink — show as empty
            nodes.push({ name: entry.name, path: relativePath, type: 'directory', children: [] });
          }
        }
      } else {
        try {
          const fileStat = await stat(fullPath);
          nodes.push({ name: entry.name, path: relativePath, type: 'file', size: fileStat.size });
        } catch {
          // File may have been removed or is a broken symlink — show with size 0
          nodes.push({ name: entry.name, path: relativePath, type: 'file', size: 0 });
        }
      }
    }
    return nodes;
  }

  /**
   * Remove session workspace directories whose manifests are older than maxAgeMs.
   * Returns the number of directories removed.
   */
  async pruneStaleWorkspaces(maxAgeMs: number = 10 * 365 * 24 * 60 * 60 * 1000): Promise<number> {
    let removed = 0;
    const now = Date.now();
    try {
      const orgs = await readdir(this.baseDir, { withFileTypes: true });
      for (const org of orgs) {
        if (!org.isDirectory()) continue;
        const orgDir = join(this.baseDir, org.name);
        const scopes = await readdir(orgDir, { withFileTypes: true }).catch(() => []);
        for (const scope of scopes) {
          if (!scope.isDirectory()) continue;
          const sessionsDir = join(orgDir, scope.name, 'sessions');
          const sessions = await readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
          for (const sess of sessions) {
            if (!sess.isDirectory()) continue;
            const wsPath = join(sessionsDir, sess.name);
            const manifest = await this.readManifest(wsPath);
            const lastSync = manifest?.lastSyncedAt ? new Date(manifest.lastSyncedAt).getTime() : 0;
            if (now - lastSync > maxAgeMs) {
              await rm(wsPath, { recursive: true, force: true }).catch(() => {});
              removed++;
            }
          }
        }
      }
    } catch {
      // baseDir may not exist yet
    }
    return removed;
  }
}

function safeWorkspaceName(value: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  return normalized || 'agent';
}

function parseLegacyAgentMarkdown(
  content: string,
  fallbackName: string,
): { name: string; description: string; instructions: string } {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatter) {
    return {
      name: fallbackName,
      description: `Migrated workspace agent ${fallbackName}`,
      instructions: content.trim(),
    };
  }

  const metadata = frontmatter[1] ?? '';
  const getField = (field: string): string | undefined => {
    const match = metadata.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim();
  };
  return {
    name: getField('name') ?? fallbackName,
    description: getField('description') ?? `Migrated workspace agent ${fallbackName}`,
    instructions: (frontmatter[2] ?? '').trim(),
  };
}

async function listRelativeFiles(root: string, prefix = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listRelativeFiles(join(root, entry.name), relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function tomlKey(value: string): string {
  return JSON.stringify(value);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlMultiline(value: string): string {
  return `"""${value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}"""`;
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineStringMap(values: Record<string, unknown>): string {
  const entries = Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`);
  return `{ ${entries.join(', ')} }`;
}

function isMcpServerMap(value: unknown): value is Record<string, MCPServerSDKConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every(server => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
    const type = (server as Record<string, unknown>).type;
    return type === 'stdio' || type === 'sse' || type === 'http';
  });
}

function removeTomlSections(content: string, prefix: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const section = line.trim().match(/^\[([^\]]+)\]$/)?.[1];
    if (section) skipping = section.startsWith(prefix);
    if (!skipping) kept.push(line);
  }
  return kept.join('\n');
}

function renderCodexMcpServers(
  servers: Record<string, MCPServerSDKConfig>,
): string {
  const lines: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${tomlKey(name)}]`);
    if (server.type === 'stdio' && server.command) {
      lines.push(`command = ${tomlString(server.command)}`);
      if (server.args?.length) lines.push(`args = ${tomlArray(server.args)}`);
      if (server.env && Object.keys(server.env).length > 0) {
        lines.push(`env = ${tomlInlineStringMap(server.env)}`);
      }
    } else if (server.url) {
      lines.push(`url = ${tomlString(server.url)}`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push(`http_headers = ${tomlInlineStringMap(server.headers)}`);
      }
    }
    lines.push('required = true', '');
  }
  return lines.join('\n').trimEnd();
}

export const workspaceManager = new WorkspaceManager();
