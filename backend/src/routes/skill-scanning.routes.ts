/**
 * Skill Scanning Routes
 *
 * Endpoints for triggering and querying LLM-powered skill security scans.
 *
 * POST /api/skills/scanning/scan       — Trigger a scan (manual)
 * GET  /api/skills/scanning/:id        — Get all scan results for a skill
 * GET  /api/skills/scanning/:id/summary — Get latest scan summary per type
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth.js';
import {
  scanSkill,
  getSkillScanResults,
  getSkillScanSummary,
  ALL_SCAN_TYPES,
  type ScanType,
} from '../services/skill-scanning.service.js';

interface ScanBody {
  Body: {
    skill_id: string;
    scan_types?: ScanType[];
  };
}

interface SkillIdParam {
  Params: { id: string };
}

export async function skillScanningRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/skills/scanning/scan
   * Trigger a scan on a skill. Runs synchronously and returns results.
   * For async (fire-and-forget) scanning, use triggerAsyncScan from service layer.
   */
  fastify.post<ScanBody>(
    '/scan',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<ScanBody>, reply: FastifyReply) => {
      const { skill_id, scan_types } = request.body;
      if (!skill_id) {
        return reply.status(400).send({ error: 'skill_id is required', code: 'VALIDATION_ERROR' });
      }

      const types = scan_types && scan_types.length > 0
        ? scan_types.filter(t => ALL_SCAN_TYPES.includes(t))
        : ALL_SCAN_TYPES;

      const results = await scanSkill(skill_id, types);
      return reply.status(200).send({ data: results });
    },
  );

  /**
   * GET /api/skills/scanning/:id
   * Get all scan results for a skill (ordered by most recent first).
   */
  fastify.get<SkillIdParam>(
    '/:id',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<SkillIdParam>, reply: FastifyReply) => {
      const results = await getSkillScanResults(request.params.id);
      return reply.status(200).send({ data: results });
    },
  );

  /**
   * GET /api/skills/scanning/:id/summary
   * Get the latest scan summary (one result per scan type) for a skill.
   */
  fastify.get<SkillIdParam>(
    '/:id/summary',
    { preHandler: [authenticate] },
    async (request: FastifyRequest<SkillIdParam>, reply: FastifyReply) => {
      const summary = await getSkillScanSummary(request.params.id);
      return reply.status(200).send({ data: summary });
    },
  );
}
