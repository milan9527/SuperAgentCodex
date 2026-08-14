import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  WorkspaceManager,
  type AgentForWorkspace,
  type ScopeForWorkspace,
} from '../../src/services/workspace-manager.js';

vi.mock('../../src/repositories/scope-memory.repository.js', () => ({
  scopeMemoryRepository: {
    findForContext: vi.fn().mockResolvedValue([]),
  },
}));

describe('WorkspaceManager Codex layout', () => {
  let baseDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    baseDir = join(tmpdir(), `workspace-manager-codex-${randomUUID()}`);
    await mkdir(baseDir, { recursive: true });
    manager = new WorkspaceManager(baseDir, { send: async () => ({}) } as never, 'codex');
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('deduplicates concurrent provisioning for the same session workspace', async () => {
    const result = {
      workspacePath: join(baseDir, 'workspace'),
      pluginPaths: [],
    };
    const provision = vi.spyOn(
      manager as unknown as {
        provisionSessionWorkspace: () => Promise<typeof result>;
      },
      'provisionSessionWorkspace',
    ).mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return result;
    });
    const scope: ScopeForWorkspace = {
      id: 'scope-1',
      name: 'Operations',
      description: null,
      systemPrompt: null,
      configVersion: 1,
      agents: [],
      skills: [],
    };

    const [first, second] = await Promise.all([
      manager.ensureSessionWorkspace('org-1', 'session-1', scope, null),
      manager.ensureSessionWorkspace('org-1', 'session-1', scope, null),
    ]);

    expect(first).toBe(result);
    expect(second).toBe(result);
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('generates Codex instructions, skills, custom agents, and project config', async () => {
    const skillSource = join(baseDir, 'source-skill');
    await mkdir(skillSource, { recursive: true });
    await writeFile(join(skillSource, 'SKILL.md'), '# Analyze\n\nInspect the workspace.\n', 'utf-8');

    const workspacePath = await manager.ensureWorkspace('agent-1', [{
      id: 'skill-1',
      name: 'analyze',
      hashId: 'hash-1',
      s3Bucket: '',
      s3Prefix: '',
      localPath: skillSource,
    }]);

    const agents: AgentForWorkspace[] = [{
      id: 'agent-1',
      name: 'risk-reviewer',
      displayName: 'Risk Reviewer',
      role: 'Review operational risk',
      systemPrompt: 'Review evidence before drawing conclusions.',
      skillNames: ['analyze'],
    }];
    const scope: ScopeForWorkspace = {
      id: 'scope-1',
      name: 'Operations',
      description: 'Operational analysis workspace.',
      systemPrompt: null,
      configVersion: 1,
      agents,
      skills: [],
      mcpServers: [],
    };

    await manager.generateScopeClaudeMd(workspacePath, scope, null, undefined, 'codex');
    await manager.generateCodexAgentFiles(join(workspacePath, '.codex', 'agents'), agents);
    await manager.generateSettings(workspacePath, [], null, agents);

    await expect(access(join(workspacePath, '.agents', 'skills', 'analyze', 'SKILL.md')))
      .resolves.toBeUndefined();

    const instructions = await readFile(join(workspacePath, 'AGENTS.md'), 'utf-8');
    expect(instructions).toContain('# Operations');
    expect(instructions).toContain('risk-reviewer');
    expect(instructions).toContain('`.codex/scope-system-prompt.md`');

    const agentConfig = await readFile(
      join(workspacePath, '.codex', 'agents', 'risk-reviewer.toml'),
      'utf-8',
    );
    expect(agentConfig).toContain('name = "risk-reviewer"');
    expect(agentConfig).toContain('description = "Risk Reviewer - Review operational risk"');
    expect(agentConfig).toContain('developer_instructions = """');

    const projectConfig = await readFile(join(workspacePath, '.codex', 'config.toml'), 'utf-8');
    expect(projectConfig).toContain('approval_policy = "never"');
    expect(projectConfig).toContain('sandbox_mode = "workspace-write"');
    expect(projectConfig).toContain('[features]');
    expect(projectConfig).toContain('hooks = true');
    expect(projectConfig).toContain('[agents."risk-reviewer"]');
    expect(projectConfig).toContain('config_file = "agents/risk-reviewer.toml"');

    const hooks = JSON.parse(
      await readFile(join(workspacePath, '.codex', 'hooks.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(hooks).toHaveProperty('hooks.PreToolUse');
    const hookScript = await readFile(
      join(workspacePath, '.codex', 'hooks', 'security-policy.mjs'),
      'utf-8',
    );
    expect(hookScript).toContain("permissionDecision: 'deny'");
    await expect(access(join(workspacePath, 'CLAUDE.md'))).rejects.toThrow();
    await expect(access(join(workspacePath, '.claude'))).rejects.toThrow();
  });

  it('writes session MCP configuration only to Codex and canonical files', async () => {
    const workspacePath = manager.getSessionWorkspacePath('org-1', 'scope-1', 'session-1');
    await mkdir(workspacePath, { recursive: true });
    await manager.generateSettings(workspacePath, [], null, []);

    await manager.updateWorkspaceMcpServer(
      'org-1',
      'scope-1',
      'session-1',
      'workflow-progress',
      {
        type: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { EVENT_FILE: '.runtime/events.jsonl' },
      },
    );

    expect(await manager.readWorkspaceMcpServers(workspacePath)).toEqual({
      'workflow-progress': {
        type: 'stdio',
        command: 'node',
        args: ['server.mjs'],
        env: { EVENT_FILE: '.runtime/events.jsonl' },
      },
    });
    const codexConfig = await readFile(join(workspacePath, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('[mcp_servers."workflow-progress"]');
    expect(codexConfig).toContain('command = "node"');
    await expect(access(join(workspacePath, '.claude'))).rejects.toThrow();

    await manager.updateWorkspaceMcpServer(
      'org-1',
      'scope-1',
      'session-1',
      'workflow-progress',
      null,
    );
    expect(await manager.readWorkspaceMcpServers(workspacePath)).toEqual({});
    expect(await readFile(join(workspacePath, '.codex', 'config.toml'), 'utf-8'))
      .not.toContain('[mcp_servers."workflow-progress"]');
  });

  it('migrates legacy Claude files before removing the inactive layout', async () => {
    const workspacePath = join(baseDir, 'legacy-workspace');
    await mkdir(join(workspacePath, '.claude', 'skills', 'legacy-only'), { recursive: true });
    await mkdir(join(workspacePath, '.claude', 'agents'), { recursive: true });
    await mkdir(join(workspacePath, '.agents', 'skills'), { recursive: true });
    await writeFile(join(workspacePath, 'CLAUDE.md'), '# Legacy instructions\n', 'utf-8');
    await writeFile(join(workspacePath, 'AGENTS.md'), '# Existing Codex instructions\n', 'utf-8');
    await writeFile(
      join(workspacePath, '.claude', 'skills', 'legacy-only', 'SKILL.md'),
      '# Legacy-only skill\n',
      'utf-8',
    );
    await writeFile(
      join(workspacePath, '.claude', 'agents', 'legacy-reviewer.md'),
      [
        '---',
        'name: legacy-reviewer',
        'description: Reviews legacy evidence',
        '---',
        '',
        'Review evidence carefully.',
      ].join('\n'),
      'utf-8',
    );
    await writeFile(
      join(workspacePath, '.claude', 'settings.json'),
      JSON.stringify({
        mcpServers: {
          legacy: {
            type: 'stdio',
            command: 'node',
            args: ['legacy-server.mjs'],
          },
        },
      }),
      'utf-8',
    );

    await expect(manager.migrateWorkspaceToActiveLayout(workspacePath)).resolves.toBe(true);

    expect(await readFile(join(workspacePath, 'AGENTS.md'), 'utf-8'))
      .toBe('# Existing Codex instructions\n');
    expect(await readFile(
      join(workspacePath, '.agents', 'skills', 'legacy-only', 'SKILL.md'),
      'utf-8',
    )).toContain('Legacy-only skill');
    expect(await readFile(
      join(workspacePath, '.codex', 'agents', 'legacy-reviewer.toml'),
      'utf-8',
    )).toContain('developer_instructions = """Review evidence carefully."""');
    const config = await readFile(join(workspacePath, '.codex', 'config.toml'), 'utf-8');
    expect(config).toContain('[agents."legacy-reviewer"]');
    expect(config).toContain('[mcp_servers."legacy"]');
    await expect(access(join(workspacePath, 'CLAUDE.md'))).rejects.toThrow();
    await expect(access(join(workspacePath, '.claude'))).rejects.toThrow();
  });
});
