/**
 * Project Squad Service
 * Manages multi-agent teams for projects.
 *
 * A project squad consists of multiple agents with different roles:
 * - leader: coordinates work, reviews, assigns issues to workers
 * - worker/frontend/backend/qa/devops: executes assigned issues
 *
 * The leader agent can:
 * 1. Auto-assign issues based on labels
 * 2. Evaluate new issues and decide which worker should handle them
 * 3. Review completed work before marking as done
 */

import { prisma } from '../config/database.js';
import { AppError } from '../middleware/errorHandler.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectAgentEntity {
  id: string;
  project_id: string;
  agent_id: string;
  role: string;
  is_leader: boolean;
  auto_assign_labels: string[];
  instructions: string | null;
  created_at: Date;
}

export interface ProjectAgentWithDetails extends ProjectAgentEntity {
  agent: {
    id: string;
    name: string;
    display_name: string;
    role: string | null;
    avatar: string | null;
    status: string;
    business_scope_id: string | null;
  };
}

export interface AddProjectAgentInput {
  agent_id: string;
  role?: string;
  is_leader?: boolean;
  auto_assign_labels?: string[];
  instructions?: string;
}

export interface UpdateProjectAgentInput {
  role?: string;
  is_leader?: boolean;
  auto_assign_labels?: string[];
  instructions?: string;
}

// ============================================================================
// Service
// ============================================================================

export class ProjectSquadService {
  /**
   * List all agents in a project squad.
   */
  async listProjectAgents(orgId: string, projectId: string): Promise<ProjectAgentWithDetails[]> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    return prisma.project_agents.findMany({
      where: { project_id: projectId },
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, status: true,
            business_scope_id: true,
          },
        },
      },
      orderBy: [{ is_leader: 'desc' }, { created_at: 'asc' }],
    }) as unknown as Promise<ProjectAgentWithDetails[]>;
  }

  /**
   * Add an agent to the project squad.
   */
  async addAgent(orgId: string, projectId: string, input: AddProjectAgentInput): Promise<ProjectAgentWithDetails> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    // Validate agent exists in the org
    const agent = await prisma.agents.findFirst({
      where: { id: input.agent_id, organization_id: orgId },
    });
    if (!agent) throw AppError.notFound('Agent not found');

    // If setting as leader, ensure no other leader exists (or demote them)
    if (input.is_leader) {
      await prisma.project_agents.updateMany({
        where: { project_id: projectId, is_leader: true },
        data: { is_leader: false, role: 'worker' },
      });
    }

    const projectAgent = await prisma.project_agents.upsert({
      where: { unique_project_agent: { project_id: projectId, agent_id: input.agent_id } },
      create: {
        project_id: projectId,
        agent_id: input.agent_id,
        role: input.is_leader ? 'leader' : (input.role ?? 'worker'),
        is_leader: input.is_leader ?? false,
        auto_assign_labels: input.auto_assign_labels ?? [],
        instructions: input.instructions ?? null,
      },
      update: {
        role: input.is_leader ? 'leader' : (input.role ?? undefined),
        is_leader: input.is_leader ?? undefined,
        auto_assign_labels: input.auto_assign_labels ?? undefined,
        instructions: input.instructions ?? undefined,
      },
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, status: true,
            business_scope_id: true,
          },
        },
      },
    });

    // Also update the project's legacy agent_id if this is the leader
    if (input.is_leader) {
      await prisma.projects.update({
        where: { id: projectId },
        data: { agent_id: input.agent_id },
      });
    }

    // Sync agent definition to project workspace (non-blocking)
    this.syncAgentToWorkspace(orgId, project, input.agent_id).catch(err => {
      console.warn('[ProjectSquad] Failed to sync agent to workspace:', err instanceof Error ? err.message : err);
    });

    return projectAgent as unknown as ProjectAgentWithDetails;
  }

  /**
   * Update a project agent's role/config.
   */
  async updateAgent(orgId: string, projectId: string, agentId: string, input: UpdateProjectAgentInput): Promise<ProjectAgentWithDetails> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    const existing = await prisma.project_agents.findFirst({
      where: { project_id: projectId, agent_id: agentId },
    });
    if (!existing) throw AppError.notFound('Agent not in this project');

    // If promoting to leader, demote current leader
    if (input.is_leader && !existing.is_leader) {
      await prisma.project_agents.updateMany({
        where: { project_id: projectId, is_leader: true },
        data: { is_leader: false, role: 'worker' },
      });
      // Update legacy agent_id
      await prisma.projects.update({
        where: { id: projectId },
        data: { agent_id: agentId },
      });
    }

    const updated = await prisma.project_agents.update({
      where: { id: existing.id },
      data: {
        ...(input.role !== undefined && { role: input.is_leader ? 'leader' : input.role }),
        ...(input.is_leader !== undefined && { is_leader: input.is_leader }),
        ...(input.auto_assign_labels !== undefined && { auto_assign_labels: input.auto_assign_labels }),
        ...(input.instructions !== undefined && { instructions: input.instructions }),
      },
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, status: true,
            business_scope_id: true,
          },
        },
      },
    });

    // Re-sync agent definition to workspace (non-blocking)
    this.syncAgentToWorkspace(orgId, project, agentId).catch(err => {
      console.warn('[ProjectSquad] Failed to sync agent to workspace:', err instanceof Error ? err.message : err);
    });

    return updated as unknown as ProjectAgentWithDetails;
  }

  /**
   * Remove an agent from the project squad.
   */
  async removeAgent(orgId: string, projectId: string, agentId: string): Promise<void> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    const existing = await prisma.project_agents.findFirst({
      where: { project_id: projectId, agent_id: agentId },
    });
    if (!existing) throw AppError.notFound('Agent not in this project');

    await prisma.project_agents.delete({ where: { id: existing.id } });

    // If removed agent was the leader, clear legacy agent_id
    if (existing.is_leader) {
      await prisma.projects.update({
        where: { id: projectId },
        data: { agent_id: null },
      });
    }

    // Remove agent definition from workspace (non-blocking)
    this.removeAgentFromWorkspace(orgId, project, agentId).catch(err => {
      console.warn('[ProjectSquad] Failed to remove agent from workspace:', err instanceof Error ? err.message : err);
    });
  }

  /**
   * Get the leader agent for a project.
   */
  async getLeader(projectId: string): Promise<ProjectAgentWithDetails | null> {
    const leader = await prisma.project_agents.findFirst({
      where: { project_id: projectId, is_leader: true },
      include: {
        agent: {
          select: {
            id: true, name: true, display_name: true,
            role: true, avatar: true, status: true,
            business_scope_id: true,
          },
        },
      },
    });
    return leader as unknown as ProjectAgentWithDetails | null;
  }

  /**
   * Auto-assign an issue to the best agent based on labels and squad config.
   * Returns the assigned agent_id, or null if no match found.
   *
   * Priority:
   * 1. Label-based matching (auto_assign_labels)
   * 2. Leader decides (if leader exists and no label match)
   * 3. Fallback to project's legacy agent_id
   */
  async assignIssueToAgent(
    _orgId: string,
    projectId: string,
    issueId: string,
    issueLabels: string[],
  ): Promise<string | null> {
    const squadMembers = await prisma.project_agents.findMany({
      where: { project_id: projectId },
      include: {
        agent: { select: { id: true, name: true, display_name: true, status: true } },
      },
    });

    if (squadMembers.length === 0) return null;

    // 1. Label-based matching
    if (issueLabels.length > 0) {
      for (const member of squadMembers) {
        if (member.auto_assign_labels.length === 0) continue;
        const hasMatch = member.auto_assign_labels.some(label =>
          issueLabels.map(l => l.toLowerCase()).includes(label.toLowerCase()),
        );
        if (hasMatch) {
          await prisma.project_issues.update({
            where: { id: issueId },
            data: { assigned_agent_id: member.agent_id },
          });
          return member.agent_id;
        }
      }
    }

    // 2. If only one non-leader worker, assign to them
    const workers = squadMembers.filter(m => !m.is_leader);
    if (workers.length === 1) {
      await prisma.project_issues.update({
        where: { id: issueId },
        data: { assigned_agent_id: workers[0]!.agent_id },
      });
      return workers[0]!.agent_id;
    }

    // 3. No auto-assignment possible — leave for leader or manual assignment
    return null;
  }

  /**
   * Get the agent that should execute a specific issue.
   * Checks assigned_agent_id first, then falls back to project agent_id.
   */
  async getExecutionAgent(orgId: string, projectId: string, issueId: string): Promise<string | null> {
    const issue = await prisma.project_issues.findFirst({
      where: { id: issueId, project_id: projectId, organization_id: orgId },
      select: { assigned_agent_id: true },
    });

    if (issue?.assigned_agent_id) return issue.assigned_agent_id;

    // Fallback: project's legacy agent_id (leader)
    const project = await prisma.projects.findFirst({
      where: { id: projectId },
      select: { agent_id: true },
    });

    return project?.agent_id ?? null;
  }

  // ==========================================================================
  // Squad Formation Strategies
  // ==========================================================================

  /**
   * Import all agents from the project's business scope into the squad.
   * Skips agents already in the squad. The first agent (by creation order)
   * is set as leader if no leader exists yet.
   *
   * Called automatically when a project's business_scope_id is set.
   */
  async importFromScope(orgId: string, projectId: string): Promise<{ imported: number; skipped: number }> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');
    if (!project.business_scope_id) return { imported: 0, skipped: 0 };

    // Get all agents in the scope
    const scopeAgents = await prisma.agents.findMany({
      where: { organization_id: orgId, business_scope_id: project.business_scope_id },
      select: { id: true, name: true, role: true },
      orderBy: { created_at: 'asc' },
    });

    if (scopeAgents.length === 0) return { imported: 0, skipped: 0 };

    // Get existing squad members
    const existing = await prisma.project_agents.findMany({
      where: { project_id: projectId },
      select: { agent_id: true, is_leader: true },
    });
    const existingIds = new Set(existing.map(e => e.agent_id));
    const hasLeader = existing.some(e => e.is_leader);

    let imported = 0;
    let skipped = 0;

    for (let i = 0; i < scopeAgents.length; i++) {
      const agent = scopeAgents[i]!;
      if (existingIds.has(agent.id)) {
        skipped++;
        continue;
      }

      // First agent becomes leader if no leader exists
      const shouldBeLeader = !hasLeader && i === 0 && imported === 0;

      await prisma.project_agents.create({
        data: {
          project_id: projectId,
          agent_id: agent.id,
          role: shouldBeLeader ? 'leader' : 'worker',
          is_leader: shouldBeLeader,
        },
      });

      // Sync legacy agent_id if this is the leader
      if (shouldBeLeader) {
        await prisma.projects.update({
          where: { id: projectId },
          data: { agent_id: agent.id },
        });
      }

      imported++;
    }

    // Sync all imported agents to workspace (non-blocking)
    if (imported > 0) {
      for (const agent of scopeAgents) {
        if (existingIds.has(agent.id)) continue;
        this.syncAgentToWorkspace(orgId, project, agent.id).catch(err => {
          console.warn(`[ProjectSquad] Failed to sync imported agent ${agent.name} to workspace:`, err instanceof Error ? err.message : err);
        });
      }
    }

    return { imported, skipped };
  }

  /**
   * AI-powered squad recommendation.
   * Analyzes the project's issues and description to suggest which agents
   * from the organization should join the squad, and what roles they should have.
   */
  async recommendSquad(orgId: string, projectId: string): Promise<{
    recommendations: Array<{
      agent_id: string;
      agent_name: string;
      suggested_role: string;
      reason: string;
      auto_assign_labels: string[];
    }>;
  }> {
    const project = await prisma.projects.findFirst({
      where: { id: projectId, organization_id: orgId },
    });
    if (!project) throw AppError.notFound('Project not found');

    // Get project issues for context
    const issues = await prisma.project_issues.findMany({
      where: { project_id: projectId, status: { not: 'cancelled' } },
      select: { title: true, labels: true, priority: true, status: true },
      orderBy: { sort_order: 'asc' },
      take: 30,
    });

    // Get all available agents in the org (not already in squad)
    const existingMembers = await prisma.project_agents.findMany({
      where: { project_id: projectId },
      select: { agent_id: true },
    });
    const existingIds = new Set(existingMembers.map(e => e.agent_id));

    const availableAgents = await prisma.agents.findMany({
      where: { organization_id: orgId, id: { notIn: [...existingIds] } },
      select: { id: true, name: true, display_name: true, role: true, business_scope_id: true },
    });

    if (availableAgents.length === 0) {
      return { recommendations: [] };
    }

    // Build prompt
    const issueContext = issues.length > 0
      ? issues.map(i => `- [${i.status}] ${i.title} (${i.priority}) labels: ${(i.labels as string[]).join(', ') || 'none'}`).join('\n')
      : '(no issues yet)';

    const agentContext = availableAgents.map(a =>
      `- id:"${a.id}" name:"${a.display_name}" role:"${a.role || 'general'}" scope:${a.business_scope_id ? 'scoped' : 'independent'}`
    ).join('\n');

    const prompt = `You are a project staffing advisor. Based on the project context, recommend which agents should join the project team.

## Project
Name: ${project.name}
Description: ${project.description || 'No description'}
${project.repo_url ? `Repository: ${project.repo_url}` : ''}

## Current Issues
${issueContext}

## Available Agents (not yet in the project)
${agentContext}

## Instructions
- Recommend 1-5 agents that would be most useful for this project
- For each, suggest a role (leader/frontend/backend/qa/devops/worker)
- Suggest auto_assign_labels: which issue labels should auto-route to this agent
- Only recommend agents whose capabilities match the project needs
- If no agents are a good fit, return an empty array

Return ONLY valid JSON (no markdown):
{"recommendations":[{"agent_id":"...","agent_name":"...","suggested_role":"worker","reason":"one sentence why","auto_assign_labels":["label1"]}]}`;

    try {
      const { aiService } = await import('./ai.service.js');
      const response = await aiService.chatCompletion({
        system_prompt: 'You are a project staffing advisor. Return only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
      });

      // Parse response
      let jsonStr = response.trim();
      const match = jsonStr.match(/\{[\s\S]*\}/);
      if (match) jsonStr = match[0];

      const parsed = JSON.parse(jsonStr) as { recommendations?: Array<{ agent_id: string; agent_name: string; suggested_role: string; reason: string; auto_assign_labels?: string[] }> };

      // Validate agent_ids exist in available list
      const validIds = new Set(availableAgents.map(a => a.id));
      const recommendations = (parsed.recommendations ?? [])
        .filter(r => validIds.has(r.agent_id))
        .map(r => ({
          agent_id: r.agent_id,
          agent_name: r.agent_name || availableAgents.find(a => a.id === r.agent_id)?.display_name || '',
          suggested_role: r.suggested_role || 'worker',
          reason: r.reason || '',
          auto_assign_labels: r.auto_assign_labels ?? [],
        }));

      return { recommendations };
    } catch (err) {
      console.error('[ProjectSquad] AI recommendation failed:', err);
      return { recommendations: [] };
    }
  }

  // ==========================================================================
  // Workspace Sync — write agent definitions to project workspace
  // ==========================================================================

  /**
   * Write a cross-scope agent's definition to the project workspace.
   * Follows the selected runtime's canonical agent and skill layout.
   *
   * Same-scope agents are skipped (already handled by workspace provisioning).
   */
  async syncAgentToWorkspace(
    orgId: string,
    project: { id: string; business_scope_id: string | null; workspace_session_id: string | null },
    agentId: string,
  ): Promise<void> {
    if (!project.workspace_session_id || !project.business_scope_id) return;

    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');
    const { workspaceManager } = await import('./workspace-manager.js');

    const wsPath = workspaceManager.getSessionWorkspacePath(
      orgId, project.business_scope_id, project.workspace_session_id,
    );

    // Load full agent data with skills
    const agent = await prisma.agents.findFirst({
      where: { id: agentId, organization_id: orgId },
      include: {
        agent_skills: {
          include: { skill: { select: { id: true, name: true, display_name: true, description: true } } },
        },
      },
    });
    if (!agent) return;

    // Skip same-scope agents — they're already provisioned by workspace manager
    if (agent.business_scope_id === project.business_scope_id) {
      return;
    }

    // Load project_agent record for role/instructions
    const projectAgent = await prisma.project_agents.findFirst({
      where: { project_id: project.id, agent_id: agentId },
    });

    const runtime = workspaceManager.getActiveRuntimeName();
    const layout = workspaceManager.getActiveRuntimeLayout();
    const safeName = agent.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
    const agentsDir = join(wsPath, layout.agentsDir);
    await mkdir(agentsDir, { recursive: true });

    const skills = agent.agent_skills ?? [];
    const skillNames = skills
      .map(entry => entry.skill?.name)
      .filter((name): name is string => Boolean(name));
    const projectInstructions = [
      agent.system_prompt || '',
      `Project role: ${projectAgent?.role ?? 'worker'}.`,
      projectAgent?.is_leader ? 'Act as the project squad leader.' : '',
      projectAgent?.auto_assign_labels?.length
        ? `Auto-assign labels: ${projectAgent.auto_assign_labels.join(', ')}.`
        : '',
      `Source scope: ${agent.business_scope_id}.`,
      projectAgent?.instructions || '',
    ].filter(Boolean).join('\n\n');

    if (runtime === 'codex') {
      await workspaceManager.generateCodexAgentFiles(agentsDir, [{
        id: agent.id,
        name: safeName,
        displayName: agent.display_name,
        role: agent.role,
        systemPrompt: projectInstructions,
        skillNames,
      }]);
    } else {
      const agentContent = [
        `# ${agent.display_name}`,
        '',
        projectInstructions,
      ].join('\n');
      await writeFile(join(agentsDir, `${safeName}.md`), agentContent, 'utf-8');
    }

    // Write skills alongside the scope's own runtime-native skills.
    if (skills.length > 0) {
      for (const as of skills) {
        const skill = as.skill;
        if (!skill) continue;

        const skillDirName = skill.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
        const skillDir = join(wsPath, layout.skillsDir, skillDirName);
        await mkdir(skillDir, { recursive: true });

        const skillContent = [
          '---',
          `name: ${skill.name}`,
          `description: ${skill.description || `Skill supplied by ${agent.display_name}`}`,
          '---',
          '',
          `# ${skill.display_name || skill.name}`,
          '',
          skill.description || '(no description)',
          '',
          `Source: ${agent.display_name} (${agent.name})`,
        ].join('\n');

        await writeFile(join(skillDir, 'SKILL.md'), skillContent, 'utf-8');
      }
    }

    console.log(`[ProjectSquad] Synced agent "${agent.display_name}" to workspace ${layout.agentsDir}/${safeName}`);
  }

  /**
   * Remove an agent's definition and skills from the project workspace.
   */
  private async removeAgentFromWorkspace(
    orgId: string,
    project: { id: string; business_scope_id: string | null; workspace_session_id: string | null },
    agentId: string,
  ): Promise<void> {
    if (!project.workspace_session_id || !project.business_scope_id) return;

    const { rm, unlink } = await import('fs/promises');
    const { join } = await import('path');
    const { workspaceManager } = await import('./workspace-manager.js');

    const wsPath = workspaceManager.getSessionWorkspacePath(
      orgId, project.business_scope_id, project.workspace_session_id,
    );

    // Load agent with skills to know what to remove
    const agent = await prisma.agents.findFirst({
      where: { id: agentId, organization_id: orgId },
      include: {
        agent_skills: { include: { skill: { select: { name: true } } } },
      },
    });
    if (!agent) return;

    const safeName = agent.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');

    const layout = workspaceManager.getActiveRuntimeLayout();
    const extension = workspaceManager.getActiveRuntimeName() === 'codex' ? '.toml' : '.md';
    try {
      await unlink(join(wsPath, layout.agentsDir, `${safeName}${extension}`));
    } catch { /* file might not exist */ }

    // Remove agent's skills from the selected runtime's skill directory.
    for (const as of agent.agent_skills ?? []) {
      const skill = as.skill;
      if (!skill) continue;
      const skillDirName = skill.name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
      try {
        await rm(join(wsPath, layout.skillsDir, skillDirName), { recursive: true, force: true });
      } catch { /* skill dir might not exist */ }
    }

    console.log(`[ProjectSquad] Removed agent "${agent.name}" and its skills from workspace`);
  }
}

export const projectSquadService = new ProjectSquadService();
