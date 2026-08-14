/**
 * Chat Room Routes
 * REST API endpoints for group chat room management.
 *
 * All group chat messages go through the A2A Orchestrator, which
 * routes to the best agent (single) or coordinates multi-agent
 * collaboration. Each agent runs in its own full runtime with
 * workspace, skills, and MCP tools.
 */

import { FastifyInstance } from 'fastify';
import { authenticate, requireModifyAccess } from '../middleware/auth.js';
import { chatRoomService } from '../services/chat-room.service.js';

export async function chatRoomRoutes(fastify: FastifyInstance): Promise<void> {

  // ==========================================================================
  // Room Lifecycle
  // ==========================================================================

  /**
   * POST /api/chat/rooms — Create a group chat room
   */
  fastify.post<{
    Body: {
      title?: string;
      business_scope_id?: string;
      agent_ids: string[];
    };
  }>(
    '/',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const room = await chatRoomService.createRoom(
        request.user!.orgId,
        request.user!.id,
        {
          title: request.body.title,
          businessScopeId: request.body.business_scope_id,
          agentIds: request.body.agent_ids,
        },
      );
      return reply.status(201).send(room);
    }
  );

  /**
   * POST /api/chat/rooms/from-scope — Create room from all agents in a scope
   */
  fastify.post<{ Body: { business_scope_id: string } }>(
    '/from-scope',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const room = await chatRoomService.createRoomFromScope(
        request.user!.orgId,
        request.user!.id,
        request.body.business_scope_id,
      );
      return reply.status(201).send(room);
    }
  );

  /**
   * POST /api/chat/rooms/cross-scope — Create a cross-scope group chat room
   * Body: { title?: string, primary_scope_id?: string, members: [{ agent_id, scope_id }] }
   */
  fastify.post<{
    Body: {
      title?: string;
      primary_scope_id?: string;
      members: Array<{ agent_id: string; scope_id: string }>;
    };
  }>(
    '/cross-scope',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const room = await chatRoomService.createCrossScopeRoom(
        request.user!.orgId,
        request.user!.id,
        {
          title: request.body.title,
          primaryScopeId: request.body.primary_scope_id,
          members: request.body.members.map(m => ({
            agentId: m.agent_id,
            scopeId: m.scope_id,
          })),
        },
      );
      return reply.status(201).send(room);
    }
  );

  /**
   * GET /api/chat/rooms/:roomId — Get room details with members
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/:roomId',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { chatSessionRepository } = await import('../repositories/chat.repository.js');
      const session = await chatSessionRepository.findById(request.params.roomId, request.user!.orgId);
      if (!session) return reply.status(404).send({ error: 'Room not found' });

      const members = await chatRoomService.getMembers(request.user!.orgId, request.params.roomId);
      return reply.status(200).send({ ...session, members });
    }
  );

  /**
   * DELETE /api/chat/rooms/:roomId — Delete a room
   */
  fastify.delete<{ Params: { roomId: string } }>(
    '/:roomId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { chatSessionRepository } = await import('../repositories/chat.repository.js');
      await chatSessionRepository.delete(request.params.roomId, request.user!.orgId);
      return reply.status(204).send();
    }
  );

  // ==========================================================================
  // Member Management
  // ==========================================================================

  /**
   * GET /api/chat/rooms/:roomId/members
   */
  fastify.get<{ Params: { roomId: string } }>(
    '/:roomId/members',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const members = await chatRoomService.getMembers(request.user!.orgId, request.params.roomId);
      return reply.status(200).send({ members });
    }
  );

  /**
   * POST /api/chat/rooms/:roomId/members — Add agent to room (supports cross-scope)
   */
  fastify.post<{ Params: { roomId: string }; Body: { agent_id: string; source_scope_id?: string } }>(
    '/:roomId/members',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await chatRoomService.addMember(
        request.user!.orgId,
        request.params.roomId,
        request.body.agent_id,
        request.user!.id,
        request.body.source_scope_id,
      );
      return reply.status(201).send({ ok: true });
    }
  );

  /**
   * DELETE /api/chat/rooms/:roomId/members/:agentId — Remove agent from room
   */
  fastify.delete<{ Params: { roomId: string; agentId: string } }>(
    '/:roomId/members/:agentId',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      await chatRoomService.removeMember(
        request.user!.orgId,
        request.params.roomId,
        request.params.agentId,
      );
      return reply.status(204).send();
    }
  );

  /**
   * PUT /api/chat/rooms/:roomId/members/:agentId/leader — Set agent as room leader
   */
  fastify.put<{ Params: { roomId: string; agentId: string }; Body: { is_leader: boolean; leader_instructions?: string } }>(
    '/:roomId/members/:agentId/leader',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const { chatRoomMemberRepository: memberRepo } = await import('../repositories/chat-room-member.repository.js');
      const { prisma } = await import('../config/database.js');
      const roomId = request.params.roomId;
      const agentId = request.params.agentId;
      const { is_leader, leader_instructions } = request.body;

      if (is_leader) {
        // Demote current leader
        await prisma.chat_room_members.updateMany({
          where: { session_id: roomId, is_leader: true },
          data: { is_leader: false, role: 'member', leader_instructions: null },
        });
        // Promote new leader
        await prisma.chat_room_members.updateMany({
          where: { session_id: roomId, agent_id: agentId },
          data: { is_leader: true, role: 'leader', leader_instructions: leader_instructions ?? null },
        });
      } else {
        // Demote this agent
        await prisma.chat_room_members.updateMany({
          where: { session_id: roomId, agent_id: agentId },
          data: { is_leader: false, role: 'member', leader_instructions: null },
        });
      }

      const members = await memberRepo.findBySession(roomId);
      return reply.send({ members });
    }
  );

  // ==========================================================================
  // Group Chat Messaging
  // ==========================================================================

  /**
   * POST /api/chat/rooms/:roomId/messages — Send message, route to agent, and get response
   */
  /**
   * POST /api/chat/rooms/:roomId/messages — Send message, route to agent, stream response via SSE.
   *
   * Returns SSE stream with events:
   *   - route: { type: 'route', ...routeDecision }
   *   - assistant: { type: 'assistant', content: ContentBlock[] }
   *   - done: data: [DONE]
   *   - error: { type: 'error', message: string }
   *
   * The user's original message (not the contextual prompt) is persisted.
   * The AI response is persisted as plain text (not raw content blocks).
   */
  fastify.post<{
    Params: { roomId: string };
    Body: { content: string; mention_agent_id?: string; swarm?: boolean };
  }>(
    '/:roomId/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const orgId = request.user!.orgId;
      const roomId = request.params.roomId;
      const { content, mention_agent_id } = request.body;

      const { chatMessageRepository } = await import('../repositories/chat.repository.js');
      const { formatSSEEvent } = await import('../utils/sse.js');

      // Persist the user's original message (not the contextual prompt)
      await chatMessageRepository.create({
        session_id: roomId,
        type: 'user',
        content,
        agent_id: null,
        mention_agent_id: mention_agent_id ?? null,
        metadata: {},
      }, orgId);

      // ── Routing: Leader mode or A2A Orchestrator ─────────────────────
      // If room has a leader agent, leader evaluates first.
      // Otherwise, A2A Orchestrator decides routing via LLM.
      {
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        try {
          const { a2aOrchestrator } = await import('../services/a2a-orchestrator.service.js');
          const { chatRoomMemberRepository: memberRepo } = await import('../repositories/chat-room-member.repository.js');
          const { roomLeaderService } = await import('../services/room-leader.service.js');
          const members = await memberRepo.findBySession(roomId);

          // Ensure the room session has a workspace (for file output)
          const { chatSessionRepository } = await import('../repositories/chat.repository.js');
          const session = await chatSessionRepository.findById(roomId, orgId);
          const primaryScopeId = session?.business_scope_id;
          if (primaryScopeId) {
            try {
              const { ChatService } = await import('../services/chat.service.js');
              const roomChatService = new ChatService();
              await roomChatService.provisionSessionWorkspace(roomId, orgId);
            } catch (err) {
              console.warn('[ROOM] Failed to provision workspace:', err instanceof Error ? err.message : err);
            }
          }

          // Build AgentEndpoint list from room members
          const agents = members
            .filter(m => m.is_active)
            .map(m => ({
              agentId: m.agent_id,
              name: m.agent.name,
              displayName: m.agent.display_name,
              role: m.agent.role || 'assistant',
              endpoint: `local://${m.agent_id}`,
            }));

          // ── Check for Leader mode ──────────────────────────────────────
          const leader = members.find(m => m.is_leader && m.is_active);
          let mentionOverride = mention_agent_id;

          if (leader && !mention_agent_id) {
            // Leader evaluates the message
            reply.raw.write(formatSSEEvent({
              data: JSON.stringify({
                type: 'leader_evaluating',
                leaderId: leader.agent_id,
                leaderName: leader.agent.display_name,
              }),
            }));

            const recentMessages = await chatMessageRepository.findBySession(orgId, roomId, { limit: 10 });
            const decision = await roomLeaderService.evaluate({
              message: content,
              leader,
              members,
              recentMessages: recentMessages.reverse(),
            });

            // Send leader decision event
            reply.raw.write(formatSSEEvent({
              data: JSON.stringify({
                type: 'leader_decision',
                action: decision.action,
                reasoning: decision.reasoning,
                delegateToAgentId: decision.delegateToAgentId,
              }),
            }));

            if (decision.action === 'silent') {
              // No response needed
              reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
              reply.raw.end();
              return;
            }

            if (decision.action === 'self') {
              // Leader answers directly — treat as @mention to leader
              mentionOverride = leader.agent_id;
            } else if (decision.action === 'delegate' && decision.delegateToAgentId) {
              // Delegate to specific agent
              mentionOverride = decision.delegateToAgentId;
            }
            // 'collaborate' falls through to orchestrator with tasks
            if (decision.action === 'collaborate' && decision.tasks?.length) {
              // Pass tasks to orchestrator
              const result = await a2aOrchestrator.orchestrate({
                roomId,
                organizationId: orgId,
                userId: request.user!.id,
                message: content,
                agents,
                config: { strategy: 'parallel' },
              });

              // Stream findings as they come
              for (const finding of result.findings) {
                reply.raw.write(formatSSEEvent({
                  data: JSON.stringify({
                    type: 'agent_finding',
                    agentId: finding.agentId,
                    agentName: finding.agentName,
                    round: finding.round,
                    status: finding.status,
                    durationMs: finding.durationMs,
                  }),
                }));
              }

              // Send route info
              reply.raw.write(formatSSEEvent({
                data: JSON.stringify({
                  type: 'route',
                  targetAgentId: leader.agent_id,
                  targetAgentName: leader.agent.display_name,
                  confidence: 1.0,
                  reasoning: `Leader coordinated multi-agent collaboration (${result.agentsInvolved.length} agents)`,
                  routedBy: 'leader',
                }),
              }));

              // Send synthesis
              reply.raw.write(formatSSEEvent({
                data: JSON.stringify({
                  type: 'assistant',
                  content: [{ type: 'text', text: result.finalReport }],
                }),
              }));

              reply.raw.write(formatSSEEvent({
                data: JSON.stringify({
                  type: 'swarm_completed',
                  rounds: result.rounds,
                  agentsInvolved: result.agentsInvolved,
                  durationMs: result.totalDurationMs,
                }),
              }));

              reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
              reply.raw.end();
              return;
            }
          }

          // ── Standard orchestration (single/multi decided by orchestrator) ──
          reply.raw.write(formatSSEEvent({
            data: JSON.stringify({
              type: 'swarm_started',
              agents: agents.map(a => ({ id: a.agentId, name: a.displayName, role: a.role })),
            }),
          }));

          const result = await a2aOrchestrator.orchestrate({
            roomId,
            organizationId: orgId,
            userId: request.user!.id,
            message: content,
            agents,
            mentionAgentId: mentionOverride,
          });

          // Send per-agent findings for transparency
          if (result.mode === 'multi') {
            for (const finding of result.findings) {
              reply.raw.write(formatSSEEvent({
                data: JSON.stringify({
                  type: 'agent_finding',
                  agentId: finding.agentId,
                  agentName: finding.agentName,
                  round: finding.round,
                  status: finding.status,
                  durationMs: finding.durationMs,
                }),
              }));
            }
          }

          // Send route info
          const primaryAgent = agents.find(a => result.agentsInvolved.includes(a.agentId)) ?? agents[0];
          if (primaryAgent) {
            reply.raw.write(formatSSEEvent({
              data: JSON.stringify({
                type: 'route',
                targetAgentId: primaryAgent.agentId,
                targetAgentName: primaryAgent.displayName,
                confidence: 1.0,
                reasoning: result.mode === 'single'
                  ? `Routed to ${primaryAgent.displayName}`
                  : `Multi-agent collaboration (${result.agentsInvolved.length} agents)`,
                routedBy: leader ? 'leader' : 'auto',
              }),
            }));
          }

          // Send the final synthesis
          reply.raw.write(formatSSEEvent({
            data: JSON.stringify({
              type: 'assistant',
              content: [{ type: 'text', text: result.finalReport }],
            }),
          }));

          // Send completion event
          reply.raw.write(formatSSEEvent({
            data: JSON.stringify({
              type: 'swarm_completed',
              rounds: result.rounds,
              agentsInvolved: result.agentsInvolved,
              durationMs: result.totalDurationMs,
            }),
          }));
        } catch (err) {
          console.error(`[ROOM] Swarm failed for room ${roomId}:`, err instanceof Error ? err.message : err);
          try {
            reply.raw.write(formatSSEEvent({
              data: JSON.stringify({ type: 'error', message: 'Multi-agent collaboration failed. Please try again.' }),
            }));
          } catch { /* client gone */ }
        }

        try {
          reply.raw.write(formatSSEEvent({ data: '[DONE]' }));
          reply.raw.end();
        } catch { /* client gone */ }
      }
    }
  );

  /**
   * GET /api/chat/rooms/:roomId/messages — Get message history
   */
  fastify.get<{ Params: { roomId: string }; Querystring: { limit?: number; before?: string } }>(
    '/:roomId/messages',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const { chatMessageRepository } = await import('../repositories/chat.repository.js');
      const messages = await chatMessageRepository.findBySession(
        request.user!.orgId,
        request.params.roomId,
        {
          limit: Number(request.query.limit) || 50,
          before: request.query.before ? new Date(request.query.before) : undefined,
        },
      );
      return reply.status(200).send({ messages: messages.reverse() });
    }
  );

  // ==========================================================================
  // In-Room Agent Creation
  // ==========================================================================

  /**
   * POST /api/chat/rooms/:roomId/create-agent — Suggest a new agent for the room
   */
  fastify.post<{ Params: { roomId: string }; Body: { description: string } }>(
    '/:roomId/create-agent',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const result = await chatRoomService.suggestAgentForRoom(
        request.user!.orgId,
        request.params.roomId,
        request.body.description,
      );
      return reply.status(200).send(result);
    }
  );

  /**
   * POST /api/chat/rooms/:roomId/create-agent/confirm — Create and add agent to room
   */
  fastify.post<{
    Params: { roomId: string };
    Body: { name: string; display_name: string; role?: string; system_prompt?: string; tools?: unknown[] };
  }>(
    '/:roomId/create-agent/confirm',
    { preHandler: [authenticate, requireModifyAccess] },
    async (request, reply) => {
      const result = await chatRoomService.createAgentInRoom(
        request.user!.orgId,
        request.params.roomId,
        request.user!.id,
        request.body,
      );
      return reply.status(201).send(result);
    }
  );
}
