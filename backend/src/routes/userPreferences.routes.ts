/**
 * User Preferences Routes
 *
 * Account-level UI preferences stored on the profile (JSONB `preferences`
 * column). Currently backs the sidebar feature toggles, but the shape is a
 * free-form object so new preference keys can be added without a migration.
 *
 *   GET /api/user/preferences  — returns the current user's preferences object
 *   PUT /api/user/preferences  — merges the given object into preferences
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { authenticate } from '../middleware/auth.js';
import { prisma } from '../config/database.js';

export async function userPreferencesRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/user/preferences */
  fastify.get(
    '/preferences',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.id;
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      const profile = await prisma.profiles.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });

      return reply.send({ preferences: profile?.preferences ?? {} });
    },
  );

  /**
   * PUT /api/user/preferences
   * Shallow-merges the provided object into the stored preferences, so a
   * client can update a single key without clobbering the others.
   */
  fastify.put(
    '/preferences',
    { preHandler: [authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user?.id;
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      }

      const patch =
        request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? (request.body as Record<string, unknown>)
          : {};

      const existing = await prisma.profiles.findUnique({
        where: { id: userId },
        select: { preferences: true },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Profile not found', code: 'NOT_FOUND' });
      }

      const current = (existing.preferences ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...patch };

      const updated = await prisma.profiles.update({
        where: { id: userId },
        data: { preferences: merged as Prisma.InputJsonValue },
        select: { preferences: true },
      });

      return reply.send({ preferences: updated.preferences });
    },
  );
}
