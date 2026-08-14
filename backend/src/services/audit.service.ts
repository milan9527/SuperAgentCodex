/**
 * Audit Service
 *
 * Centralized audit logging for enterprise compliance (SOC 2, GDPR, 等保).
 * Records all significant operations: who did what, to which resource, when.
 *
 * Usage:
 *   await auditService.log({
 *     orgId: user.orgId,
 *     actorId: user.id,
 *     actorEmail: user.email,
 *     action: 'agent.create',
 *     resourceType: 'agent',
 *     resourceId: agent.id,
 *     resourceName: agent.displayName,
 *     scopeId: agent.business_scope_id,
 *     metadata: { name: agent.name },
 *     ip: request.ip,
 *     userAgent: request.headers['user-agent'],
 *   });
 */

import { prisma } from '../config/database.js';
import type { Prisma } from '@prisma/client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  orgId: string;
  actorId: string;
  actorEmail?: string;
  action: AuditAction;
  resourceType: AuditResourceType;
  resourceId?: string;
  resourceName?: string;
  scopeId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

export type AuditAction =
  // Auth
  | 'auth.login'
  | 'auth.logout'
  | 'auth.register'
  // Agents
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  | 'agent.enable'
  | 'agent.disable'
  // Business Scopes
  | 'scope.create'
  | 'scope.update'
  | 'scope.delete'
  | 'scope.visibility_change'
  // Scope Members
  | 'scope.member.add'
  | 'scope.member.remove'
  | 'scope.member.role_change'
  // Workflows
  | 'workflow.create'
  | 'workflow.update'
  | 'workflow.delete'
  | 'workflow.execute'
  // Knowledge / Documents
  | 'knowledge.upload'
  | 'knowledge.delete'
  | 'knowledge.sync'
  // Skills
  | 'skill.install'
  | 'skill.remove'
  | 'skill.equip'
  | 'skill.unequip'
  // MCP Servers
  | 'mcp.assign'
  | 'mcp.remove'
  | 'mcp.call'
  // Organization
  | 'org.update'
  | 'org.member.invite'
  | 'org.member.remove'
  | 'org.member.role_change'
  // API Keys
  | 'apikey.create'
  | 'apikey.delete'
  // Data Connectors
  | 'connector.create'
  | 'connector.delete'
  // Generic fallback
  | string;

export type AuditResourceType =
  | 'agent'
  | 'scope'
  | 'workflow'
  | 'knowledge'
  | 'skill'
  | 'mcp_server'
  | 'organization'
  | 'member'
  | 'api_key'
  | 'connector'
  | 'chat_session'
  | string;

export interface AuditLogFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  scopeId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface AuditLogRecord {
  id: string;
  organization_id: string;
  actor_id: string;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  resource_name: string | null;
  scope_id: string | null;
  metadata: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class AuditService {
  /**
   * Write an audit log entry. Fire-and-forget by default (non-blocking).
   * Errors are logged but never thrown to avoid disrupting the main operation.
   */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.audit_logs.create({
        data: {
          organization_id: entry.orgId,
          actor_id: entry.actorId,
          actor_email: entry.actorEmail ?? null,
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId ?? null,
          resource_name: entry.resourceName ?? null,
          scope_id: entry.scopeId ?? null,
          metadata: entry.metadata as Prisma.InputJsonValue | undefined,
          ip_address: entry.ip ?? null,
          user_agent: entry.userAgent ?? null,
        },
      });
    } catch (err) {
      // Never let audit logging break the main flow
      console.error('[AuditService] Failed to write audit log:', err);
    }
  }

  /**
   * Write multiple audit log entries in a batch.
   */
  async logBatch(entries: AuditLogEntry[]): Promise<void> {
    try {
      await prisma.audit_logs.createMany({
        data: entries.map((entry) => ({
          organization_id: entry.orgId,
          actor_id: entry.actorId,
          actor_email: entry.actorEmail ?? null,
          action: entry.action,
          resource_type: entry.resourceType,
          resource_id: entry.resourceId ?? null,
          resource_name: entry.resourceName ?? null,
          scope_id: entry.scopeId ?? null,
          metadata: entry.metadata as Prisma.InputJsonValue | undefined,
          ip_address: entry.ip ?? null,
          user_agent: entry.userAgent ?? null,
        })),
      });
    } catch (err) {
      console.error('[AuditService] Failed to write batch audit logs:', err);
    }
  }

  /**
   * Query audit logs with filtering and pagination.
   */
  async query(
    orgId: string,
    filter: AuditLogFilter = {},
    page = 1,
    limit = 50,
  ): Promise<{ data: AuditLogRecord[]; total: number; page: number; limit: number; totalPages: number }> {
    const where: Record<string, unknown> = { organization_id: orgId };

    if (filter.actorId) where.actor_id = filter.actorId;
    if (filter.action) where.action = { startsWith: filter.action };
    if (filter.resourceType) where.resource_type = filter.resourceType;
    if (filter.scopeId) where.scope_id = filter.scopeId;

    if (filter.startDate || filter.endDate) {
      const dateFilter: Record<string, Date> = {};
      if (filter.startDate) dateFilter.gte = filter.startDate;
      if (filter.endDate) dateFilter.lte = filter.endDate;
      where.created_at = dateFilter;
    }

    const [data, total] = await Promise.all([
      prisma.audit_logs.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.audit_logs.count({ where }),
    ]);

    return {
      data: data as unknown as AuditLogRecord[],
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Export audit logs as CSV-ready rows.
   * Returns all matching records (up to 10,000) for CSV export.
   */
  async export(
    orgId: string,
    filter: AuditLogFilter = {},
  ): Promise<AuditLogRecord[]> {
    const where: Record<string, unknown> = { organization_id: orgId };

    if (filter.actorId) where.actor_id = filter.actorId;
    if (filter.action) where.action = { startsWith: filter.action };
    if (filter.resourceType) where.resource_type = filter.resourceType;
    if (filter.scopeId) where.scope_id = filter.scopeId;

    if (filter.startDate || filter.endDate) {
      const dateFilter: Record<string, Date> = {};
      if (filter.startDate) dateFilter.gte = filter.startDate;
      if (filter.endDate) dateFilter.lte = filter.endDate;
      where.created_at = dateFilter;
    }

    const data = await prisma.audit_logs.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 10000, // Hard cap for export
    });

    return data as unknown as AuditLogRecord[];
  }

  /**
   * Get summary statistics for the audit dashboard.
   */
  async getStats(orgId: string, days = 30): Promise<{
    totalEvents: number;
    uniqueActors: number;
    topActions: Array<{ action: string; count: number }>;
  }> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const where = { organization_id: orgId, created_at: { gte: since } };

    const [totalEvents, actorGroups, actionGroups] = await Promise.all([
      prisma.audit_logs.count({ where }),
      prisma.audit_logs.groupBy({
        by: ['actor_id'],
        where,
        _count: true,
      }),
      prisma.audit_logs.groupBy({
        by: ['action'],
        where,
        _count: true,
        orderBy: { _count: { action: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      totalEvents,
      uniqueActors: actorGroups.length,
      topActions: actionGroups.map((g) => ({
        action: g.action,
        count: g._count,
      })),
    };
  }
}

export const auditService = new AuditService();
