/**
 * LiteLLM Routes
 *
 * Proxy endpoint for fetching available models from a LiteLLM instance.
 * Credentials are stored server-side (LITELLM_BASE_URL + LITELLM_API_KEY).
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, requireAdminAccess } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { modelProviderRepository } from '../repositories/model-provider.repository.js';
import { credentialVaultService } from '../services/credential-vault.service.js';
import { listBedrockModels } from '../services/bedrock-models.service.js';
import { normalizeLiteLLMBaseUrl } from '../utils/litellm-base-url.js';

export async function litellmRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/litellm/models — Admin-only live provider catalog.
   * Returns both the public model name (for display) and the LiteLLM
   * model identifier (for passing to Claude Code SDK).
   *
   * With `?providerId=<id>` it uses that provider's base_url + decrypted
   * api_key. Without it, falls back to the global LITELLM_BASE_URL/API_KEY env
   * (preserves the legacy scope model picker behavior).
   */
  fastify.get<{ Querystring: { providerId?: string; refresh?: string; bedrock?: string } }>(
    '/models',
    { preHandler: [authenticate, requireAdminAccess] },
    async (request: FastifyRequest<{ Querystring: { providerId?: string; refresh?: string; bedrock?: string } }>, reply: FastifyReply) => {
      let baseUrl = config.litellm.baseUrl;
      let apiKey = config.litellm.apiKey;
      const refresh = request.query.refresh === 'true' || request.query.refresh === '1';

      // Direct Bedrock listing (no provider row needed — region-based), used by
      // the create form before a provider id exists.
      if (request.query.bedrock === 'true' || request.query.bedrock === '1') {
        try {
          const models = await listBedrockModels(refresh);
          return reply.status(200).send({
            data: models.map(m => ({ id: m.name, litellm_model: m.id, provider: m.provider })),
          });
        } catch (err) {
          console.error('[litellm] bedrock model list failed:', err instanceof Error ? err.message : err);
          return reply.status(200).send({ data: [] });
        }
      }

      const providerId = request.query.providerId;
      if (providerId) {
        const provider = await modelProviderRepository.findById(providerId, request.user!.orgId);
        if (!provider) {
          return reply.status(200).send({ data: [] });
        }
        // Bedrock providers → list live AWS Bedrock models for the region.
        if (provider.type === 'bedrock') {
          try {
            const models = await listBedrockModels(refresh);
            return reply.status(200).send({
              data: models.map(m => ({ id: m.name, litellm_model: m.id, provider: m.provider })),
            });
          } catch (err) {
            console.error('[litellm] bedrock model list failed:', err instanceof Error ? err.message : err);
            return reply.status(200).send({ data: [] });
          }
        }
        if (provider.type !== 'litellm' || !provider.base_url) {
          return reply.status(200).send({ data: [] });
        }
        baseUrl = provider.base_url;
        apiKey = undefined;
        if (provider.credential_id) {
          try {
            const data = await credentialVaultService.decryptCredential(provider.credential_id, request.user!.orgId);
            apiKey = typeof data.api_key === 'string' ? data.api_key : undefined;
          } catch {
            /* leave apiKey undefined */
          }
        }
      }

      if (!baseUrl) {
        return reply.status(200).send({ data: [] });
      }

      const base = normalizeLiteLLMBaseUrl(baseUrl);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

      // 1) Try /model/info (LiteLLM admin route — richest metadata, but often
      //    forbidden for restricted "virtual" keys).
      try {
        const resp = await fetch(`${base}/model/info`, { headers, signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const body = (await resp.json()) as {
            data?: Array<{
              model_name: string;
              litellm_params?: { model?: string };
              model_info?: { litellm_provider?: string };
            }>;
          };
          const models = (body.data ?? []).map(m => ({
            id: m.model_name,
            litellm_model: m.litellm_params?.model ?? m.model_name,
            provider: m.model_info?.litellm_provider ?? 'litellm',
          }));
          if (models.length > 0) return reply.status(200).send({ data: models });
        } else {
          console.warn(`[litellm] /model/info ${resp.status}; falling back to /v1/models`);
        }
      } catch (err) {
        console.warn('[litellm] /model/info error; falling back to /v1/models:', err instanceof Error ? err.message : err);
      }

      // 2) Fall back to the OpenAI-standard /v1/models list (allowed for
      //    restricted keys; returns just model ids).
      try {
        const resp = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) {
          console.error(`[litellm] /v1/models failed: ${resp.status}`);
          return reply.status(200).send({ data: [] });
        }
        const body = (await resp.json()) as { data?: Array<{ id: string }> };
        const models = (body.data ?? [])
          .filter(m => m.id)
          .map(m => ({ id: m.id, litellm_model: m.id, provider: 'litellm' }));
        return reply.status(200).send({ data: models });
      } catch (err) {
        console.error('[litellm] Failed to fetch models:', err instanceof Error ? err.message : err);
        return reply.status(200).send({ data: [] });
      }
    },
  );
}
