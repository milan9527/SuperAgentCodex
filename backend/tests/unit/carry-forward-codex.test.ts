import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  s3Send: vi.fn(),
  prisma: {
    skills: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agents: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    business_scopes: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    scope_mcp_servers: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    mcp_servers: {
      create: vi.fn(),
    },
  },
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  GetObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
  ListObjectsV2Command: class {
    constructor(readonly input: unknown) {}
  },
  PutObjectCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock('../../src/config/database.js', () => ({ prisma: mocks.prisma }));
vi.mock('../../src/config/index.js', () => ({
  config: {
    agentcore: {
      region: 'us-east-1',
      workspaceS3Bucket: 'workspace-bucket',
    },
    aws: { region: 'us-east-1' },
    s3: { skillsBucket: 'skills-bucket' },
  },
}));

import { CarryForwardService } from '../../src/services/carry-forward.service.js';

const workspaces: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.s3Send.mockResolvedValue({});
  mocks.prisma.skills.findMany.mockResolvedValue([]);
  mocks.prisma.skills.create.mockResolvedValue({ id: 'skill-1' });
  mocks.prisma.skills.update.mockResolvedValue({});
  mocks.prisma.agents.findMany.mockResolvedValue([]);
  mocks.prisma.agents.create.mockResolvedValue({ id: 'agent-1' });
  mocks.prisma.agents.update.mockResolvedValue({});
  mocks.prisma.business_scopes.findUnique.mockImplementation(
    ({ select }: { select?: Record<string, boolean> }) => {
      if (select?.system_prompt) return Promise.resolve({ system_prompt: 'old prompt' });
      return Promise.resolve({ settings: {} });
    },
  );
  mocks.prisma.business_scopes.update.mockResolvedValue({});
  mocks.prisma.scope_mcp_servers.findMany.mockResolvedValue([]);
  mocks.prisma.scope_mcp_servers.create.mockResolvedValue({});
  mocks.prisma.mcp_servers.create.mockResolvedValue({ id: 'mcp-1' });
});

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(path => (
    rm(path, { recursive: true, force: true })
  )));
});

describe('CarryForwardService Codex workspace', () => {
  it('round-trips every supported Codex artifact and bumps the scope version once', async () => {
    const workspace = await createWorkspace();
    const service = new CarryForwardService();

    const result = await service.syncFromSession('org-1', 'scope-1', 'session-1', {
      localWorkspacePath: workspace,
    });

    expect(result).toEqual({
      skills: ['audit-skill'],
      agents: ['audit-agent'],
      claudeMdUpdated: true,
      settingsUpdated: true,
      hooksUpdated: true,
      systemPromptUpdated: true,
    });
    expect(mocks.prisma.skills.create).toHaveBeenCalledOnce();
    expect(mocks.prisma.agents.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'audit-agent',
        display_name: 'Audit Agent',
        role: 'Reviewer',
        system_prompt: 'Review the workspace carefully.',
      }),
    });
    expect(mocks.prisma.mcp_servers.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'tenant-audit',
        host_address: 'node server.mjs',
      }),
    });
    expect(mocks.prisma.business_scopes.update).toHaveBeenCalledWith({
      where: { id: 'scope-1' },
      data: { config_version: { increment: 1 } },
    });
  });

  it('fails the entire carry-forward when any supported artifact cannot persist', async () => {
    const workspace = await createWorkspace();
    mocks.prisma.skills.create.mockRejectedValueOnce(new Error('database denied'));
    const service = new CarryForwardService();

    await expect(service.syncFromSession('org-1', 'scope-1', 'session-1', {
      localWorkspacePath: workspace,
    })).rejects.toThrow(
      'Failed to carry one or more skills: audit-skill: database denied',
    );
    expect(mocks.prisma.business_scopes.update).not.toHaveBeenCalled();
  });

  it('updates an existing skill in its recorded bucket instead of the global default', async () => {
    const workspace = await createWorkspace();
    mocks.prisma.skills.findMany
      .mockResolvedValueOnce([{
        id: 'skill-1',
        name: 'audit-skill',
        hash_id: 'audit-hash',
        version: '1.0.0',
        s3_bucket: 'tenant-skills-bucket',
        s3_prefix: 'skills/audit-hash/',
        metadata: { body: 'old body' },
      }])
      .mockResolvedValueOnce([]);
    const service = new CarryForwardService();

    await service.syncFromSession('org-1', 'scope-1', 'session-1', {
      localWorkspacePath: workspace,
    });

    const putInputs = mocks.s3Send.mock.calls.map(([command]) => (
      (command as { input: { Bucket?: string } }).input
    ));
    expect(putInputs).toContainEqual(expect.objectContaining({
      Bucket: 'tenant-skills-bucket',
    }));
    expect(putInputs).not.toContainEqual(expect.objectContaining({
      Bucket: 'skills-bucket',
    }));
    expect(mocks.prisma.skills.update).toHaveBeenCalledWith({
      where: { id: 'skill-1' },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          body: '# Audit Skill\n\nChecks generated artifacts.\n',
        }),
      }),
    });
  });

  it('does not recreate an organization-level skill as a scope skill', async () => {
    const workspace = await createWorkspace();
    mocks.prisma.skills.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'audit-skill' }]);
    const service = new CarryForwardService();

    const result = await service.syncFromSession('org-1', 'scope-1', 'session-1', {
      localWorkspacePath: workspace,
    });

    expect(result.skills).toEqual([]);
    expect(mocks.prisma.skills.create).not.toHaveBeenCalled();
    expect(mocks.s3Send).not.toHaveBeenCalled();
    expect(mocks.prisma.skills.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        organization_id: 'org-1',
        status: 'active',
        name: { in: ['audit-skill'] },
        OR: [
          { business_scope_id: null },
          { business_scope_id: { not: 'scope-1' } },
        ],
      },
      select: { name: true },
    });
  });

  it('does not persist generated Codex skill context into the agent system prompt', async () => {
    const workspace = await createWorkspace();
    await writeFile(
      join(workspace, '.codex', 'agents', 'audit-agent.toml'),
      [
        'name = "audit-agent"',
        'description = "Audit Agent - Reviewer"',
        'developer_instructions = """Review the workspace carefully.',
        '',
        'Relevant project skills are available under .agents/skills: audit-skill.',
        '',
        'Relevant project skills are available under .agents/skills: audit-skill."""',
        '',
      ].join('\n'),
    );
    mocks.prisma.agents.findMany.mockResolvedValue([{
      id: 'agent-1',
      name: 'audit-agent',
      system_prompt: 'Old prompt',
      role: 'Reviewer',
    }]);
    const service = new CarryForwardService();

    await service.syncFromSession('org-1', 'scope-1', 'session-1', {
      localWorkspacePath: workspace,
    });

    expect(mocks.prisma.agents.update).toHaveBeenCalledWith({
      where: { id: 'agent-1' },
      data: {
        system_prompt: 'Review the workspace carefully.',
        role: 'Reviewer',
      },
    });
  });
});

async function createWorkspace(): Promise<string> {
  const workspace = join(tmpdir(), `carry-forward-codex-${randomUUID()}`);
  workspaces.push(workspace);
  await Promise.all([
    mkdir(join(workspace, '.agents', 'skills', 'audit-skill'), { recursive: true }),
    mkdir(join(workspace, '.codex', 'agents'), { recursive: true }),
    mkdir(join(workspace, '.runtime'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(workspace, '.agents', 'skills', 'audit-skill', 'SKILL.md'),
      '# Audit Skill\n\nChecks generated artifacts.\n',
    ),
    writeFile(
      join(workspace, '.codex', 'agents', 'audit-agent.toml'),
      [
        'name = "audit-agent"',
        'description = "Audit Agent - Reviewer"',
        'developer_instructions = """Review the workspace carefully."""',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(workspace, 'AGENTS.md'),
      [
        '# Workspace',
        '',
        '<!-- CUSTOM_SECTION: Agent-generated rules below -->',
        'Always validate generated artifacts.',
        '',
      ].join('\n'),
    ),
    writeFile(
      join(workspace, '.codex', 'scope-system-prompt.md'),
      'Updated scope prompt.',
    ),
    writeFile(
      join(workspace, '.runtime', 'mcp-servers.json'),
      JSON.stringify({
        'tenant-audit': {
          type: 'stdio',
          command: 'node',
          args: ['server.mjs'],
        },
      }),
    ),
    writeFile(
      join(workspace, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PostToolUse: [{
            hooks: [{ type: 'command', command: 'node audit-hook.mjs' }],
          }],
        },
      }),
    ),
  ]);
  return workspace;
}
