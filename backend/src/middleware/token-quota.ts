/**
 * Token Quota Middleware
 *
 * Fastify preHandler hook that checks whether the authenticated user
 * has remaining token quota before allowing execution of LLM-consuming
 * operations (chat, workflow execution, scope generation).
 *
 * Returns 429 (Too Many Requests) with quota details when exceeded.
 */

import { FastifyRequest, FastifyReply } from 'fastify';
import { checkTokenQuota } from '../services/token-quota.service.js';

/**
 * Middleware that enforces token quota before LLM execution.
 * Must be placed AFTER the `authenticate` middleware in the preHandler chain.
 */
export async function enforceTokenQuota(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = request.user;
  if (!user) {
    // Should not happen if authenticate runs first, but guard anyway
    reply.code(401).send({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    return;
  }

  const result = await checkTokenQuota(user.orgId, user.id);

  if (!result.allowed) {
    reply.code(429).send({
      error: 'Token quota exceeded',
      code: 'QUOTA_EXCEEDED',
      details: {
        reason: result.reason,
        currentTokens: result.currentTokens,
        currentCostUsd: result.currentCostUsd,
        tokenLimit: result.tokenLimit,
        costLimit: result.costLimit,
        usagePercent: result.usagePercent,
      },
    });
    return;
  }
}
