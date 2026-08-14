/**
 * Audit Log Middleware
 *
 * Fastify onResponse hook factory that automatically logs successful
 * mutating operations (POST, PUT, PATCH, DELETE) to the audit trail.
 *
 * Usage (per-route):
 *   fastify.post('/agents', {
 *     preHandler: [authenticate, requireModifyAccess],
 *     onResponse: auditHook('agent.create', 'agent'),
 *   }, handler)
 *
 * Usage (global — logs all mutating requests):
 *   fastify.addHook('onResponse', globalAuditHook)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { auditService, type AuditAction, type AuditResourceType } from '../services/audit.service.js';

/**
 * Creates a per-route onResponse hook that logs the operation to the audit trail.
 * Only logs on successful responses (2xx status codes).
 */
export function auditHook(
  action: AuditAction,
  resourceType: AuditResourceType,
  opts?: {
    /** Extract resource ID from the response or request */
    getResourceId?: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
    /** Extract resource name from the response or request */
    getResourceName?: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
    /** Extract scope ID from the request */
    getScopeId?: (request: FastifyRequest) => string | undefined;
    /** Extract additional metadata */
    getMetadata?: (request: FastifyRequest) => Record<string, unknown> | undefined;
  },
) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Only log successful mutations
    if (reply.statusCode < 200 || reply.statusCode >= 300) return;
    if (!request.user) return;

    const params = request.params as Record<string, string>;

    await auditService.log({
      orgId: request.user.orgId,
      actorId: request.user.id,
      actorEmail: request.user.email,
      action,
      resourceType,
      resourceId: opts?.getResourceId?.(request, reply) ?? params?.id ?? undefined,
      resourceName: opts?.getResourceName?.(request, reply) ?? undefined,
      scopeId: opts?.getScopeId?.(request) ?? params?.scopeId ?? undefined,
      metadata: opts?.getMetadata?.(request) ?? undefined,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  };
}

/**
 * Global audit hook — automatically logs all successful mutating requests.
 * Attach to the Fastify instance to get broad audit coverage without per-route config.
 *
 * Skips: GET requests, health checks, auth endpoints, non-authenticated requests.
 */
export async function globalAuditHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Only log mutations
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
  // Only log successful responses
  if (reply.statusCode < 200 || reply.statusCode >= 300) return;
  // Skip unauthenticated requests
  if (!request.user) return;
  // Skip health and auth routes
  if (request.url.startsWith('/health') || request.url.includes('/auth/')) return;

  const params = request.params as Record<string, string>;
  const body = request.body as Record<string, unknown> | undefined;

  // Infer action from method + URL
  const method = request.method;
  const urlParts = request.url.replace(/\?.*$/, '').split('/').filter(Boolean);
  // e.g. /api/agents → resource = 'agents', /api/business-scopes/:id/members → resource = 'scope.member'
  const resourceSegment = urlParts[1] || 'unknown'; // skip 'api'
  const subResource = urlParts[3] || '';

  const actionVerb = method === 'POST' ? 'create'
    : method === 'PUT' || method === 'PATCH' ? 'update'
    : method === 'DELETE' ? 'delete'
    : 'unknown';

  const resourceType = resourceSegment.replace(/-/g, '_');
  const action = subResource
    ? `${resourceType}.${subResource}.${actionVerb}`
    : `${resourceType}.${actionVerb}`;

  await auditService.log({
    orgId: request.user.orgId,
    actorId: request.user.id,
    actorEmail: request.user.email,
    action,
    resourceType,
    resourceId: params?.id ?? params?.scopeId ?? undefined,
    resourceName: (body?.name as string) ?? (body?.display_name as string) ?? undefined,
    scopeId: params?.scopeId ?? (body?.business_scope_id as string) ?? undefined,
    metadata: body ? { body: summarizeBody(body) } : undefined,
    ip: request.ip,
    userAgent: request.headers['user-agent'],
  });
}

/**
 * Summarize request body for audit metadata (strip large fields).
 */
function summarizeBody(body: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.length > 500) {
      summary[key] = `[${value.length} chars]`;
    } else if (Array.isArray(value) && value.length > 10) {
      summary[key] = `[${value.length} items]`;
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
