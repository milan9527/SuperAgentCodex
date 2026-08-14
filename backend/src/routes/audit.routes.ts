/**
 * Audit Log Routes
 *
 * API endpoints for querying and exporting audit logs.
 * Only org admins and owners can access audit logs.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate, requireAdminAccess } from '../middleware/auth.js';
import { auditService, type AuditLogFilter } from '../services/audit.service.js';

interface AuditQueryParams {
  page?: number;
  limit?: number;
  actor_id?: string;
  action?: string;
  resource_type?: string;
  scope_id?: string;
  start_date?: string;
  end_date?: string;
}

interface AuditStatsParams {
  days?: number;
}

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {

  /**
   * GET /api/audit-logs
   * Query audit logs with filtering and pagination.
   * Requires admin or owner role.
   */
  fastify.get<{ Querystring: AuditQueryParams }>(
    '/',
    {
      preHandler: [authenticate, requireAdminAccess],
      schema: {
        description: 'Query audit logs for the organization',
        tags: ['Audit'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            actor_id: { type: 'string', format: 'uuid' },
            action: { type: 'string' },
            resource_type: { type: 'string' },
            scope_id: { type: 'string', format: 'uuid' },
            start_date: { type: 'string', format: 'date-time' },
            end_date: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AuditQueryParams }>, reply: FastifyReply) => {
      const { page = 1, limit = 50, actor_id, action, resource_type, scope_id, start_date, end_date } = request.query;

      const filter: AuditLogFilter = {};
      if (actor_id) filter.actorId = actor_id;
      if (action) filter.action = action;
      if (resource_type) filter.resourceType = resource_type;
      if (scope_id) filter.scopeId = scope_id;
      if (start_date) filter.startDate = new Date(start_date);
      if (end_date) filter.endDate = new Date(end_date);

      const result = await auditService.query(request.user!.orgId, filter, page, limit);
      return reply.status(200).send(result);
    },
  );

  /**
   * GET /api/audit-logs/export
   * Export audit logs as CSV.
   * Requires admin or owner role.
   */
  fastify.get<{ Querystring: AuditQueryParams }>(
    '/export',
    {
      preHandler: [authenticate, requireAdminAccess],
      schema: {
        description: 'Export audit logs as CSV',
        tags: ['Audit'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            actor_id: { type: 'string', format: 'uuid' },
            action: { type: 'string' },
            resource_type: { type: 'string' },
            scope_id: { type: 'string', format: 'uuid' },
            start_date: { type: 'string', format: 'date-time' },
            end_date: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AuditQueryParams }>, reply: FastifyReply) => {
      const { actor_id, action, resource_type, scope_id, start_date, end_date } = request.query;

      const filter: AuditLogFilter = {};
      if (actor_id) filter.actorId = actor_id;
      if (action) filter.action = action;
      if (resource_type) filter.resourceType = resource_type;
      if (scope_id) filter.scopeId = scope_id;
      if (start_date) filter.startDate = new Date(start_date);
      if (end_date) filter.endDate = new Date(end_date);

      const records = await auditService.export(request.user!.orgId, filter);

      // Build CSV
      const headers = [
        'timestamp', 'actor_email', 'actor_id', 'action',
        'resource_type', 'resource_id', 'resource_name',
        'scope_id', 'ip_address', 'metadata',
      ];

      const csvRows = [headers.join(',')];
      for (const r of records) {
        const row = [
          r.created_at.toISOString(),
          escapeCsv(r.actor_email || ''),
          r.actor_id,
          r.action,
          r.resource_type,
          r.resource_id || '',
          escapeCsv(r.resource_name || ''),
          r.scope_id || '',
          r.ip_address || '',
          escapeCsv(r.metadata ? JSON.stringify(r.metadata) : ''),
        ];
        csvRows.push(row.join(','));
      }

      const csv = csvRows.join('\n');
      const filename = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(csv);
    },
  );

  /**
   * GET /api/audit-logs/stats
   * Get audit log summary statistics.
   * Requires admin or owner role.
   */
  fastify.get<{ Querystring: AuditStatsParams }>(
    '/stats',
    {
      preHandler: [authenticate, requireAdminAccess],
      schema: {
        description: 'Get audit log statistics',
        tags: ['Audit'],
        security: [{ bearerAuth: [] }],
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: AuditStatsParams }>, reply: FastifyReply) => {
      const { days = 30 } = request.query;
      const stats = await auditService.getStats(request.user!.orgId, days);
      return reply.status(200).send(stats);
    },
  );
}

/** Escape a value for CSV (wrap in quotes if it contains commas, quotes, or newlines) */
function escapeCsv(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
