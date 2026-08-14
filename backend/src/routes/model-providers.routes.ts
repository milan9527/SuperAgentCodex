/**
 * Model Provider Routes
 *
 * CRUD for reusable per-org LLM providers (Bedrock or LiteLLM gateway).
 * All routes require authentication and filter by organization_id.
 * API keys are write-only — never returned (list/get expose only `hasApiKey`).
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { modelProviderService } from '../services/model-provider.service.js';
import { authenticate, requireModifyAccess } from '../middleware/auth.js';
import { createModelProviderSchema, updateModelProviderSchema } from '../schemas/model-provider.schema.js';
import { ZodError } from 'zod';
import { AppError } from '../middleware/errorHandler.js';

function validate<T>(schema: { parse: (d: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw AppError.validation('Validation failed', e.issues);
    throw e;
  }
}

export async function modelProviderRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: [authenticate] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const list = await modelProviderService.list(req.user!.orgId);
    return reply.send({ data: list });
  });

  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const provider = await modelProviderService.getById(req.params.id, req.user!.orgId);
      return reply.send(provider);
    },
  );

  fastify.post('/', { preHandler: [authenticate, requireModifyAccess] }, async (req: FastifyRequest, reply: FastifyReply) => {
    const input = validate(createModelProviderSchema, req.body);
    const provider = await modelProviderService.create(req.user!.orgId, input, req.user!.id);
    return reply.status(201).send(provider);
  });

  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate, requireModifyAccess] },
    async (req, reply) => {
      const input = validate(updateModelProviderSchema, req.body);
      const provider = await modelProviderService.update(req.params.id, req.user!.orgId, input);
      return reply.send(provider);
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: [authenticate, requireModifyAccess] },
    async (req, reply) => {
      await modelProviderService.delete(req.params.id, req.user!.orgId);
      return reply.status(204).send();
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/default',
    { preHandler: [authenticate, requireModifyAccess] },
    async (req, reply) => {
      const provider = await modelProviderService.setDefault(req.params.id, req.user!.orgId);
      return reply.send(provider);
    },
  );
}
