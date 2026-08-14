/**
 * Agent Access Service
 *
 * Centralized logic for agent-level access control.
 * Determines whether a user can perform operations on a specific agent based on:
 *   1. Org-level role (owner/admin bypass all agent restrictions)
 *   2. Explicit agent_permissions record
 *   3. Agent creator (created_by) — treated as owner
 *   4. Scope membership role inheritance
 *   5. Agent visibility (public / scope_default / private)
 *   6. Scope visibility (open scopes grant invoke to all org members)
 */

import { prisma } from '../config/database.js';

export type AgentAccessLevel = 'owner' | 'admin' | 'invoke' | 'view';

const LEVEL_HIERARCHY: Record<AgentAccessLevel, number> = {
  owner: 4,
  admin: 3,
  invoke: 2,
  view: 1,
};

/**
 * Map scope membership roles to agent access levels.
 * scope admin → agent admin (can edit/delete agents in scope)
 * scope member → agent invoke (can call agents)
 * scope viewer → agent view (can see agents)
 */
const SCOPE_ROLE_TO_AGENT_LEVEL: Record<string, AgentAccessLevel> = {
  admin: 'admin',
  member: 'invoke',
  viewer: 'view',
};

export class AgentAccessService {
  /**
   * Check if a user has at least the required access level to an agent.
   *
   * @param userId - The user's ID
   * @param orgId - The user's organization ID
   * @param agentId - The target agent ID
   * @param minLevel - Minimum required access level
   * @returns true if user has sufficient access
   */
  async checkAccess(
    userId: string,
    orgId: string,
    agentId: string,
    minLevel: AgentAccessLevel,
  ): Promise<boolean> {
    const minScore = LEVEL_HIERARCHY[minLevel];

    // 1. Check explicit agent_permissions record
    const explicitPerm = await (prisma as any).agent_permissions.findUnique({
      where: { unique_agent_user_permission: { agent_id: agentId, user_id: userId } },
    });
    if (explicitPerm && LEVEL_HIERARCHY[explicitPerm.permission as AgentAccessLevel] >= minScore) {
      return true;
    }

    // 2. Check if user is the creator (digital twin owner)
    const agent = await prisma.agents.findFirst({
      where: { id: agentId, organization_id: orgId },
      select: {
        created_by: true,
        business_scope_id: true,
        visibility: true,
        origin: true,
      } as any,
    }) as any;
    if (!agent) return false;

    if (agent.created_by === userId) {
      return true; // Creator always has full (owner) access
    }

    // 3. Check scope membership inheritance
    if (agent.business_scope_id) {
      const scopeMembership = await prisma.scope_memberships.findUnique({
        where: {
          business_scope_id_user_id: {
            business_scope_id: agent.business_scope_id,
            user_id: userId,
          },
        },
      });
      if (scopeMembership) {
        const derivedLevel = SCOPE_ROLE_TO_AGENT_LEVEL[scopeMembership.role] || 'view';
        if (LEVEL_HIERARCHY[derivedLevel] >= minScore) {
          return true;
        }
      }
    }

    // 4. Check agent visibility — public agents grant invoke to all org members
    if (agent.visibility === 'public' && minScore <= LEVEL_HIERARCHY['invoke']) {
      return true;
    }

    // 5. Check scope visibility — open scope agents inherit invoke for all org members
    if (agent.visibility === 'scope_default' && agent.business_scope_id) {
      const scope = await prisma.business_scopes.findUnique({
        where: { id: agent.business_scope_id },
        select: { visibility: true },
      });
      if (scope?.visibility === 'open' && minScore <= LEVEL_HIERARCHY['invoke']) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get the effective access level for a user on an agent.
   * Useful for UI to determine which actions to show.
   */
  async getEffectiveLevel(
    userId: string,
    userRole: string,
    orgId: string,
    agentId: string,
  ): Promise<AgentAccessLevel | 'none'> {
    // Org owner/admin always have full access
    if (userRole === 'owner' || userRole === 'admin') {
      return 'owner';
    }

    // Check explicit permission
    const explicitPerm = await (prisma as any).agent_permissions.findUnique({
      where: { unique_agent_user_permission: { agent_id: agentId, user_id: userId } },
    });
    if (explicitPerm) {
      return explicitPerm.permission as AgentAccessLevel;
    }

    // Check creator
    const agent = await prisma.agents.findFirst({
      where: { id: agentId, organization_id: orgId },
      select: { created_by: true, business_scope_id: true, visibility: true } as any,
    }) as any;
    if (!agent) return 'none';

    if (agent.created_by === userId) return 'owner';

    // Check scope membership
    if (agent.business_scope_id) {
      const scopeMembership = await prisma.scope_memberships.findUnique({
        where: {
          business_scope_id_user_id: {
            business_scope_id: agent.business_scope_id,
            user_id: userId,
          },
        },
      });
      if (scopeMembership) {
        return SCOPE_ROLE_TO_AGENT_LEVEL[scopeMembership.role] || 'view';
      }
    }

    // Check visibility
    if (agent.visibility === 'public') return 'invoke';

    if (agent.visibility === 'scope_default' && agent.business_scope_id) {
      const scope = await prisma.business_scopes.findUnique({
        where: { id: agent.business_scope_id },
        select: { visibility: true },
      });
      if (scope?.visibility === 'open') return 'invoke';
    }

    return 'none';
  }

  /**
   * Grant a permission to a user for an agent.
   */
  async grantPermission(
    orgId: string,
    agentId: string,
    userId: string,
    permission: AgentAccessLevel,
    grantedBy: string,
  ) {
    return (prisma as any).agent_permissions.upsert({
      where: { unique_agent_user_permission: { agent_id: agentId, user_id: userId } },
      create: {
        organization_id: orgId,
        agent_id: agentId,
        user_id: userId,
        permission,
        granted_by: grantedBy,
      },
      update: {
        permission,
        granted_by: grantedBy,
      },
    });
  }

  /**
   * Revoke a user's permission for an agent.
   */
  async revokePermission(permissionId: string) {
    return (prisma as any).agent_permissions.delete({ where: { id: permissionId } });
  }

  /**
   * List all permissions for an agent.
   */
  async listPermissions(agentId: string) {
    return (prisma as any).agent_permissions.findMany({
      where: { agent_id: agentId },
      orderBy: { created_at: 'asc' },
    });
  }

  /**
   * Update agent visibility.
   */
  async updateVisibility(agentId: string, _orgId: string, visibility: string) {
    return (prisma as any).agents.update({
      where: { id: agentId },
      data: { visibility },
    });
  }

  /**
   * Get all agents a user can access, with the source of access.
   * Used by admin UI to show "what can this user do".
   */
  async getUserAccessibleAgents(
    userId: string,
    orgId: string,
  ): Promise<Array<{
    id: string;
    name: string;
    display_name: string;
    role: string | null;
    origin: string;
    business_scope_id: string | null;
    scope_name: string | null;
    access_level: string;
    access_source: string; // 'explicit' | 'creator' | 'scope_membership' | 'public' | 'scope_open'
  }>> {
    // 1. Get all agents in the org
    const allAgents = await prisma.agents.findMany({
      where: { organization_id: orgId },
      select: {
        id: true,
        name: true,
        display_name: true,
        role: true,
        origin: true,
        business_scope_id: true,
        created_by: true,
        visibility: true,
        business_scope: { select: { name: true, visibility: true } },
      } as any,
    }) as any[];

    // 2. Get explicit permissions for this user
    const explicitPerms = await (prisma as any).agent_permissions.findMany({
      where: { user_id: userId, organization_id: orgId },
    });
    const explicitMap = new Map(explicitPerms.map((p: any) => [p.agent_id, p.permission]));

    // 3. Get scope memberships for this user
    const scopeMemberships = await prisma.scope_memberships.findMany({
      where: { user_id: userId, organization_id: orgId },
    });
    const scopeRoleMap = new Map(scopeMemberships.map(m => [m.business_scope_id, m.role]));

    // 4. Determine access for each agent
    const result: Array<{
      id: string; name: string; display_name: string; role: string | null;
      origin: string; business_scope_id: string | null; scope_name: string | null;
      access_level: string; access_source: string;
    }> = [];

    for (const agent of allAgents) {
      let accessLevel: string | null = null;
      let accessSource: string | null = null;

      // Check explicit permission
      if (explicitMap.has(agent.id)) {
        accessLevel = explicitMap.get(agent.id) as string;
        accessSource = 'explicit';
      }
      // Check creator
      else if (agent.created_by === userId) {
        accessLevel = 'owner';
        accessSource = 'creator';
      }
      // Check scope membership
      else if (agent.business_scope_id && scopeRoleMap.has(agent.business_scope_id)) {
        const scopeRole = scopeRoleMap.get(agent.business_scope_id)!;
        const mapping: Record<string, string> = { admin: 'admin', member: 'invoke', viewer: 'view' };
        accessLevel = mapping[scopeRole] || 'view';
        accessSource = 'scope_membership';
      }
      // Check public visibility
      else if (agent.visibility === 'public') {
        accessLevel = 'invoke';
        accessSource = 'public';
      }
      // Check scope_default + open scope
      else if (agent.visibility === 'scope_default' && agent.business_scope?.visibility === 'open') {
        accessLevel = 'invoke';
        accessSource = 'scope_open';
      }

      if (accessLevel) {
        result.push({
          id: agent.id,
          name: agent.name,
          display_name: agent.display_name,
          role: agent.role,
          origin: agent.origin,
          business_scope_id: agent.business_scope_id,
          scope_name: agent.business_scope?.name || null,
          access_level: accessLevel,
          access_source: accessSource!,
        });
      }
    }

    return result;
  }
}

export const agentAccessService = new AgentAccessService();
