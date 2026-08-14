/**
 * A2A-Native Orchestrator
 *
 * Coordinates multi-agent collaboration using the A2A protocol uniformly.
 * Internal agents use local:// fast path, external agents use HTTPS.
 *
 * Smart routing:
 *   1. First, ask a lightweight LLM call to decide: is this a single-agent
 *      question or a multi-agent collaboration?
 *   2. Single-agent → route to the best-fit agent, get a direct answer.
 *   3. Multi-agent → Coordinator decomposes, delegates, synthesizes.
 *
 * All messages written to chat_messages with collaboration_meta.
 */

import { a2aClient, type AgentEndpoint } from './a2a-client.service.js';
import { prisma } from '../config/database.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OrchestrateParams {
  roomId: string;
  organizationId: string;
  userId: string;
  message: string;
  agents: AgentEndpoint[];
  mentionAgentId?: string;
  config?: {
    maxRounds?: number;
    roundTimeoutMs?: number;
    strategy?: 'parallel' | 'sequential';
  };
}

export interface OrchestratorResult {
  sessionId: string;
  finalReport: string;
  rounds: number;
  agentsInvolved: string[];
  totalDurationMs: number;
  mode: 'single' | 'multi';
  findings: AgentFinding[];
}

interface AgentFinding {
  agentId: string;
  agentName: string;
  round: number;
  content: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'timeout';
}

interface RoutingDecision {
  mode: 'single' | 'multi';
  primaryAgentId: string;
  tasks?: Array<{ agentId: string; task: string }>;
  reasoning: string;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

export class A2AOrchestrator {
  /**
   * Execute a smart multi-agent collaboration session.
   */
  async orchestrate(params: OrchestrateParams): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const sessionId = crypto.randomUUID();

    if (params.agents.length === 0) {
      throw new Error('No agents available for orchestration');
    }

    // ── Build room context from chat history ────────────────────────────
    const roomContext = await this.buildRoomContext(params.roomId, params.organizationId, params.agents);

    // ── Step 1: Smart routing — decide single vs multi ─────────────────
    // If user @mentioned a specific agent, skip LLM routing
    let decision: RoutingDecision;
    if (params.mentionAgentId) {
      decision = {
        mode: 'single',
        primaryAgentId: params.mentionAgentId,
        reasoning: `User @mentioned this agent`,
      };
    } else {
      decision = await this.decideRouting(params.message, params.agents, params.organizationId);
    }

    if (decision.mode === 'single') {
      // ── Single agent: direct answer ──────────────────────────────────
      return this.executeSingleAgent(params, decision, sessionId, startTime, roomContext);
    }

    // ── Multi-agent collaboration ──────────────────────────────────────
    return this.executeMultiAgent(params, decision, sessionId, startTime, roomContext);
  }

  // ── Routing Decision ──────────────────────────────────────────────────

  private async decideRouting(
    message: string,
    agents: AgentEndpoint[],
    _organizationId: string,
  ): Promise<RoutingDecision> {
    const agentDescriptions = agents
      .map(a => `- id:"${a.agentId}" name:"${a.displayName}" role:"${a.role}"`)
      .join('\n');

    const prompt = `You are a message router for a team of AI agents. Based on the user's message, decide the best approach.

Available agents:
${agentDescriptions}

User message: "${message}"

Decide:
1. If this question is best answered by ONE specific agent, return mode "single" with that agent's id.
2. If this question needs MULTIPLE agents to collaborate (cross-domain, needs data from different sources), return mode "multi" with task assignments.

Return ONLY valid JSON:
{"mode":"single","primaryAgentId":"<id>","reasoning":"<why this agent>"}
OR
{"mode":"multi","primaryAgentId":"<coordinator-id>","tasks":[{"agentId":"<id>","task":"<specific sub-task>"}],"reasoning":"<why multi>"}

Important: In multi mode, the primaryAgentId is the coordinator who synthesizes results. Do NOT assign tasks to the coordinator — only assign tasks to other agents.`;
    try {
      const { aiService } = await import('./ai.service.js');
      const response = await aiService.chatCompletion({
        system_prompt: 'You are a routing engine. Return only valid JSON, no markdown.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as RoutingDecision;
        // Validate the primaryAgentId exists
        const validIds = new Set(agents.map(a => a.agentId));
        if (validIds.has(parsed.primaryAgentId)) {
          // Validate task agentIds if multi
          if (parsed.tasks) {
            parsed.tasks = parsed.tasks.filter(t => validIds.has(t.agentId));
          }
          return parsed;
        }
      }
    } catch (err) {
      console.warn('[orchestrator] Routing decision failed, falling back to first agent:', err);
    }

    // Fallback: single agent, pick the first one
    return {
      mode: 'single',
      primaryAgentId: agents[0]!.agentId,
      reasoning: 'Fallback — routing decision failed',
    };
  }

  // ── Single Agent Execution ────────────────────────────────────────────

  private async executeSingleAgent(
    params: OrchestrateParams,
    decision: RoutingDecision,
    sessionId: string,
    startTime: number,
    roomContext: string,
  ): Promise<OrchestratorResult> {
    const agent = params.agents.find(a => a.agentId === decision.primaryAgentId) ?? params.agents[0]!;

    // Prepend room context so the agent knows the conversation history
    const contextualMessage = roomContext
      ? `${roomContext}\n\n---\nUser message: ${params.message}`
      : params.message;

    const result = await a2aClient.sendTask({
      agentId: agent.agentId,
      endpoint: agent.endpoint,
      message: contextualMessage,
      organizationId: params.organizationId,
      timeoutMs: params.config?.roundTimeoutMs ?? 60000,
    });

    // Write the response as a normal agent message (no collaboration_meta needed for single)
    await this.writeCollabMessage(params.organizationId, params.roomId, sessionId, {
      agentId: agent.agentId,
      content: result.content,
      messageType: 'synthesis',
      sourceAgentName: agent.displayName,
      round: 0,
      durationMs: result.durationMs,
    });

    // Write to workspace
    await this.writeFindingToWorkspace(
      params.roomId, params.organizationId, agent.displayName, result.content,
    );

    return {
      sessionId,
      finalReport: result.content,
      rounds: 0,
      agentsInvolved: [agent.agentId],
      totalDurationMs: Date.now() - startTime,
      mode: 'single',
      findings: [{
        agentId: agent.agentId,
        agentName: agent.displayName,
        round: 0,
        content: result.content,
        durationMs: result.durationMs,
        status: result.status,
      }],
    };
  }

  // ── Multi-Agent Execution ─────────────────────────────────────────────

  private async executeMultiAgent(
    params: OrchestrateParams,
    decision: RoutingDecision,
    sessionId: string,
    startTime: number,
    roomContext: string,
  ): Promise<OrchestratorResult> {
    const maxRounds = params.config?.maxRounds ?? 3;
    const roundTimeout = params.config?.roundTimeoutMs ?? 60000;
    const strategy = params.config?.strategy ?? 'parallel';
    const findings: AgentFinding[] = [];
    let currentRound = 0;

    const coordinator = params.agents.find(a => a.agentId === decision.primaryAgentId) ?? params.agents[0]!;
    const agentMap = new Map(params.agents.map(a => [a.agentId, a]));

    // Use tasks from routing decision, or fall back to sending to all workers
    let tasks = decision.tasks ?? params.agents
      .filter(a => a.agentId !== coordinator.agentId)
      .map(a => ({ agentId: a.agentId, task: params.message }));

    // Filter out tasks assigned to the coordinator itself
    tasks = tasks.filter(t => t.agentId !== coordinator.agentId);

    if (tasks.length === 0) {
      // Only one agent — just answer directly
      return this.executeSingleAgent(params, decision, sessionId, startTime, roomContext);
    }

    // ── Round execution ─────────────────────────────────────────────────

    let pendingTasks = tasks;

    while (currentRound < maxRounds && pendingTasks.length > 0) {
      currentRound++;

      const executeOne = async (task: { agentId: string; task: string }): Promise<AgentFinding> => {
        const agent = agentMap.get(task.agentId);
        if (!agent) {
          return { agentId: task.agentId, agentName: task.agentId, round: currentRound, content: 'Agent not found', durationMs: 0, status: 'failed' };
        }

        // Write delegation message
        await this.writeCollabMessage(params.organizationId, params.roomId, sessionId, {
          agentId: coordinator.agentId,
          targetAgentId: agent.agentId,
          content: task.task,
          messageType: 'delegation',
          sourceAgentName: coordinator.displayName,
          targetAgentName: agent.displayName,
          round: currentRound,
        });

        const result = await a2aClient.sendTask({
          agentId: agent.agentId,
          endpoint: agent.endpoint,
          message: roomContext
            ? `${roomContext}\n\n---\nTask from coordinator: ${task.task}`
            : task.task,
          organizationId: params.organizationId,
          callerAgentId: coordinator.agentId,
          timeoutMs: roundTimeout,
        });

        // Write report message
        await this.writeCollabMessage(params.organizationId, params.roomId, sessionId, {
          agentId: agent.agentId,
          targetAgentId: coordinator.agentId,
          content: result.content,
          messageType: 'report',
          sourceAgentName: agent.displayName,
          targetAgentName: coordinator.displayName,
          round: currentRound,
          durationMs: result.durationMs,
        });

        // Write finding to workspace file
        await this.writeFindingToWorkspace(
          params.roomId, params.organizationId, agent.displayName, result.content,
        );

        return {
          agentId: agent.agentId,
          agentName: agent.displayName,
          round: currentRound,
          content: result.content,
          durationMs: result.durationMs,
          status: result.status,
        };
      };

      const roundFindings = strategy === 'sequential'
        ? await (async () => { const r: AgentFinding[] = []; for (const t of pendingTasks) r.push(await executeOne(t)); return r; })()
        : await Promise.all(pendingTasks.map(executeOne));

      findings.push(...roundFindings);

      // Simple follow-up check
      pendingTasks = roundFindings
        .filter(f => f.status === 'completed' && f.content.includes('NEED_MORE_INFO'))
        .map(f => ({ agentId: f.agentId, task: 'Follow up on your previous findings with more detail.' }));
    }

    // ── Synthesis ───────────────────────────────────────────────────────

    const findingsSummary = findings
      .filter(f => f.status === 'completed')
      .map(f => `[${f.agentName}] (Round ${f.round}):\n${f.content}`)
      .join('\n\n---\n\n');

    const synthesisPrompt = `You are synthesizing findings from a multi-agent collaboration.

Original user request: ${params.message}

Findings from agents:
${findingsSummary}

Provide a comprehensive, well-structured response that synthesizes all findings.`;

    const synthesisResult = await a2aClient.sendTask({
      agentId: coordinator.agentId,
      endpoint: coordinator.endpoint,
      message: synthesisPrompt,
      organizationId: params.organizationId,
      timeoutMs: 60000,
    });

    await this.writeCollabMessage(params.organizationId, params.roomId, sessionId, {
      agentId: coordinator.agentId,
      content: synthesisResult.content,
      messageType: 'synthesis',
      sourceAgentName: coordinator.displayName,
      round: currentRound,
      durationMs: synthesisResult.durationMs,
    });

    // Write final report to workspace
    await this.writeFindingToWorkspace(
      params.roomId, params.organizationId, 'final-report', synthesisResult.content,
    );

    return {
      sessionId,
      finalReport: synthesisResult.content,
      rounds: currentRound,
      agentsInvolved: [...new Set(findings.map(f => f.agentId))],
      totalDurationMs: Date.now() - startTime,
      mode: 'multi',
      findings,
    };
  }

  // ── Room Context ────────────────────────────────────────────────────

  /**
   * Build conversation context from recent chat messages.
   * This gives each Agent awareness of what was discussed before.
   */
  private async buildRoomContext(
    roomId: string,
    organizationId: string,
    agents: AgentEndpoint[],
  ): Promise<string> {
    try {
      const messages = await prisma.chat_messages.findMany({
        where: { session_id: roomId, organization_id: organizationId },
        orderBy: { created_at: 'desc' },
        take: 20,
        select: { type: true, content: true, agent_id: true, created_at: true },
      });

      if (messages.length === 0) return '';

      const agentMap = new Map(agents.map(a => [a.agentId, a.displayName]));

      let context = 'You are in a group chat room.\n\nRoom members:\n';
      for (const a of agents) {
        context += `- ${a.displayName}: ${a.role}\n`;
      }

      context += '\nRecent conversation:\n';
      for (const msg of messages.reverse()) {
        if (msg.type === 'system') continue;
        if (msg.type === 'user') {
          context += `[User]: ${msg.content.substring(0, 300)}\n`;
        } else {
          const name = msg.agent_id ? (agentMap.get(msg.agent_id) ?? 'AI') : 'AI';
          context += `[@${name}]: ${msg.content.substring(0, 300)}\n`;
        }
      }

      return context;
    } catch {
      return '';
    }
  }

  // ── Workspace File Writing ────────────────────────────────────────────

  /**
   * Write an Agent's findings to the room workspace as a file.
   * Creates findings/{agent-name}.md in the session workspace.
   */
  private async writeFindingToWorkspace(
    roomId: string,
    organizationId: string,
    agentName: string,
    content: string,
  ): Promise<void> {
    try {
      const { WorkspaceManager } = await import('./workspace-manager.js');
      const { chatSessionRepository } = await import('../repositories/chat.repository.js');

      const session = await chatSessionRepository.findById(roomId, organizationId);
      if (!session?.business_scope_id) return;

      const wsMgr = new WorkspaceManager();
      const wsPath = wsMgr.getSessionWorkspacePath(organizationId, session.business_scope_id, roomId);

      const { mkdir, writeFile } = await import('fs/promises');
      const { join } = await import('path');

      const findingsDir = join(wsPath, 'findings');
      await mkdir(findingsDir, { recursive: true });

      // Sanitize agent name for filename
      const safeName = agentName.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
      const filePath = join(findingsDir, `${safeName}.md`);
      await writeFile(filePath, `# ${agentName}\n\n${content}`, 'utf-8');
    } catch (err) {
      console.warn(`[orchestrator] Failed to write finding for ${agentName}:`, err);
    }
  }

  // ── Message Writing ───────────────────────────────────────────────────

  private async writeCollabMessage(
    organizationId: string,
    roomId: string,
    swarmSessionId: string,
    params: {
      agentId: string;
      targetAgentId?: string;
      content: string;
      messageType: 'delegation' | 'report' | 'question' | 'synthesis';
      sourceAgentName: string;
      targetAgentName?: string;
      round: number;
      durationMs?: number;
    },
  ): Promise<void> {
    try {
      await prisma.chat_messages.create({
        data: {
          organization_id: organizationId,
          session_id: roomId,
          type: 'agent',
          content: params.content,
          agent_id: params.agentId,
          collaboration_meta: {
            swarmSessionId,
            taskId: crypto.randomUUID(),
            sourceAgentId: params.agentId,
            sourceAgentName: params.sourceAgentName,
            targetAgentId: params.targetAgentId,
            targetAgentName: params.targetAgentName,
            messageType: params.messageType,
            round: params.round,
            durationMs: params.durationMs,
          },
        },
      });
    } catch (err) {
      console.warn('[a2a-orchestrator] Failed to write collab message:', err);
    }
  }
}

export const a2aOrchestrator = new A2AOrchestrator();
