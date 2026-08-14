/**
 * Room Leader Service
 *
 * When a chat room has a designated leader agent, all messages are first
 * evaluated by the leader who decides the execution strategy:
 *
 * 1. "self" — Leader answers directly (single agent, no delegation)
 * 2. "delegate" — Route to a specific worker agent
 * 3. "collaborate" — Multi-agent collaboration (decompose + delegate + synthesize)
 * 4. "silent" — No response needed (e.g. system messages, acknowledgments)
 *
 * The leader uses its `leader_instructions` to guide decision-making.
 * This replaces the generic LLM routing when a leader is present.
 */

import type { ChatRoomMemberWithAgent } from '../repositories/chat-room-member.repository.js';
import type { ChatMessageEntity } from '../repositories/chat.repository.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LeaderAction = 'self' | 'delegate' | 'collaborate' | 'silent';

export interface LeaderDecision {
  action: LeaderAction;
  /** For 'delegate': the target agent ID */
  delegateToAgentId?: string;
  /** For 'collaborate': task decomposition */
  tasks?: Array<{ agentId: string; task: string }>;
  /** Leader's reasoning (logged for transparency) */
  reasoning: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class RoomLeaderService {
  /**
   * Ask the leader agent to evaluate a message and decide the action.
   */
  async evaluate(params: {
    message: string;
    leader: ChatRoomMemberWithAgent;
    members: ChatRoomMemberWithAgent[];
    recentMessages: ChatMessageEntity[];
  }): Promise<LeaderDecision> {
    const { message, leader, members, recentMessages } = params;
    const workers = members.filter(m => m.agent_id !== leader.agent_id && m.is_active);

    // If no workers, leader must answer itself
    if (workers.length === 0) {
      return { action: 'self', reasoning: 'No other agents available — leader answers directly.' };
    }

    const workerDescriptions = workers
      .map(m => `- id:"${m.agent_id}" name:"${m.agent.display_name}" role:"${m.agent.role || 'assistant'}"`)
      .join('\n');

    const recentContext = recentMessages.slice(-8).map(msg => {
      if (msg.type === 'user') return `[User]: ${msg.content.substring(0, 200)}`;
      if (msg.type === 'system') return null;
      const agent = members.find(m => m.agent_id === msg.agent_id);
      return `[@${agent?.agent.display_name ?? 'AI'}]: ${msg.content.substring(0, 200)}`;
    }).filter(Boolean).join('\n');

    const leaderInstructions = leader.leader_instructions || '';

    const prompt = `You are the team leader of a group of AI agents. Your job is to evaluate the user's message and decide the best action.

## Your Team
${workerDescriptions}

## Your Coordination Instructions
${leaderInstructions || '(No specific instructions — use your best judgment)'}

## Recent Conversation
${recentContext || '(no prior messages)'}

## New User Message
"${message}"

## Decision Rules
- "self": You should answer this yourself (general questions, greetings, meta-questions about the team)
- "delegate": Route to ONE specific agent whose expertise matches best
- "collaborate": This needs MULTIPLE agents working together (cross-domain, complex analysis)
- "silent": No response needed (acknowledgments like "ok", "thanks", system messages)

Return ONLY valid JSON:
{"action":"self|delegate|collaborate|silent","delegateToAgentId":"<id if delegate>","tasks":[{"agentId":"<id>","task":"<sub-task>"}],"reasoning":"<brief explanation>"}

For "delegate": set delegateToAgentId to the target agent's id.
For "collaborate": set tasks array with sub-tasks for each agent. Do NOT include yourself in tasks.
For "self" or "silent": omit delegateToAgentId and tasks.`;

    try {
      const { aiService } = await import('./ai.service.js');
      const response = await aiService.chatCompletion({
        system_prompt: 'You are a team leader making routing decisions. Return only valid JSON.',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { action: 'self', reasoning: 'Failed to parse leader decision — defaulting to self.' };
      }

      const parsed = JSON.parse(jsonMatch[0]) as LeaderDecision;

      // Validate
      const validActions: LeaderAction[] = ['self', 'delegate', 'collaborate', 'silent'];
      if (!validActions.includes(parsed.action)) {
        return { action: 'self', reasoning: 'Invalid action from leader — defaulting to self.' };
      }

      // Validate delegate target exists
      if (parsed.action === 'delegate' && parsed.delegateToAgentId) {
        const validIds = new Set(workers.map(w => w.agent_id));
        if (!validIds.has(parsed.delegateToAgentId)) {
          // Leader suggested an invalid agent — fall back to self
          return { action: 'self', reasoning: `Leader suggested unknown agent — answering directly.` };
        }
      }

      // Validate collaborate tasks
      if (parsed.action === 'collaborate' && parsed.tasks) {
        const validIds = new Set(workers.map(w => w.agent_id));
        parsed.tasks = parsed.tasks.filter(t => validIds.has(t.agentId));
        if (parsed.tasks.length === 0) {
          return { action: 'self', reasoning: 'No valid agents for collaboration — answering directly.' };
        }
      }

      return parsed;
    } catch (err) {
      console.error('[RoomLeader] Evaluation failed:', err);
      return { action: 'self', reasoning: 'Leader evaluation failed — defaulting to self.' };
    }
  }
}

export const roomLeaderService = new RoomLeaderService();
