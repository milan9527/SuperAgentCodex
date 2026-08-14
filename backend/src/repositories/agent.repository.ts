/**
 * Agent Repository
 * Data access layer for Agent entities with multi-tenancy support.
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7, 4.8
 */

import { BaseRepository, type FindAllOptions } from './base.repository.js';
import type { AgentFilter } from '../schemas/agent.schema.js';

/**
 * Agent entity type matching the Prisma schema
 */
export interface AgentEntity {
  id: string;
  organization_id: string;
  business_scope_id: string | null;
  name: string;
  display_name: string;
  role: string | null;
  avatar: string | null;
  status: 'active' | 'idle' | 'busy' | 'offline';
  metrics: Record<string, unknown>;
  tools: unknown[];
  scope: unknown[];
  system_prompt: string | null;
  model_config: Record<string, unknown>;
  origin: string;
  is_shared: boolean;
  a2a_enabled: boolean;
  a2a_capabilities: string | null;
  a2a_exposed_skills: string[];
  registry_record_id: string | null;
  registry_record_arn: string | null;
  created_by: string | null;
  visibility: string;
  created_at: Date;
  updated_at: Date;
}

export type AgentCreateData = Pick<AgentEntity, 'name' | 'display_name'> &
  Partial<
    Omit<
      AgentEntity,
      'id' | 'organization_id' | 'name' | 'display_name' | 'created_at' | 'updated_at'
    >
  >;

/**
 * Agent Repository class extending BaseRepository with agent-specific methods.
 * Provides multi-tenancy filtering for all operations.
 */
export class AgentRepository extends BaseRepository<AgentEntity> {
  constructor() {
    super('agents');
  }

  async create(data: AgentCreateData, organizationId: string): Promise<AgentEntity> {
    return this.getModel().create({
      data: {
        business_scope_id: null,
        role: null,
        avatar: null,
        status: 'active',
        metrics: {},
        tools: [],
        scope: [],
        system_prompt: null,
        model_config: {},
        origin: 'scope_generation',
        is_shared: false,
        a2a_enabled: false,
        a2a_capabilities: null,
        a2a_exposed_skills: [],
        registry_record_id: null,
        registry_record_arn: null,
        created_by: null,
        visibility: 'scope_default',
        ...data,
        organization_id: organizationId,
      },
    });
  }

  /**
   * Find all agents with optional filters.
   * Supports filtering by status and business_scope_id.
   *
   * @param organizationId - The organization ID to filter by
   * @param filters - Optional filters (status, business_scope_id, name)
   * @param options - Optional query options (pagination, ordering)
   * @returns Array of agents matching the criteria
   */
  async findAllWithFilters(
    organizationId: string,
    filters?: AgentFilter,
    options?: Omit<FindAllOptions<AgentEntity>, 'where'>
  ): Promise<AgentEntity[]> {
    const where: Partial<AgentEntity> = {};

    if (filters?.status) {
      where.status = filters.status;
    }

    if (filters?.business_scope_id) {
      where.business_scope_id = filters.business_scope_id;
    }

    if (filters?.name) {
      // For name filtering, we'll use contains search
      // This requires a different approach with Prisma
    }

    return this.findAll(organizationId, {
      ...options,
      where,
    });
  }

  /**
   * Find agents by business scope.
   *
   * @param organizationId - The organization ID to filter by
   * @param businessScopeId - The business scope ID to filter by
   * @returns Array of agents in the specified business scope
   */
  async findByBusinessScope(
    organizationId: string,
    businessScopeId: string
  ): Promise<AgentEntity[]> {
    return this.findAll(organizationId, {
      where: { business_scope_id: businessScopeId },
    });
  }

  /**
   * Find agents by status.
   *
   * @param organizationId - The organization ID to filter by
   * @param status - The status to filter by
   * @returns Array of agents with the specified status
   */
  async findByStatus(
    organizationId: string,
    status: AgentEntity['status']
  ): Promise<AgentEntity[]> {
    return this.findAll(organizationId, {
      where: { status },
    });
  }

  /**
   * Find agent by name within an organization and optional business scope.
   * When businessScopeId is provided, checks uniqueness within that scope.
   * When businessScopeId is undefined, checks across the whole organization.
   *
   * @param organizationId - The organization ID to filter by
   * @param name - The agent name to search for
   * @param businessScopeId - Optional business scope ID to narrow the search
   * @returns The agent if found, null otherwise
   */
  async findByName(organizationId: string, name: string, businessScopeId?: string | null): Promise<AgentEntity | null> {
    const where: Partial<AgentEntity> = { name };
    if (businessScopeId !== undefined) {
      where.business_scope_id = businessScopeId;
    }
    return this.findFirst(organizationId, where);
  }

  /**
   * Update agent status.
   *
   * @param id - The agent ID
   * @param organizationId - The organization ID to filter by
   * @param status - The new status
   * @returns The updated agent, or null if not found
   */
  async updateStatus(
    id: string,
    organizationId: string,
    status: AgentEntity['status']
  ): Promise<AgentEntity | null> {
    return this.update(id, organizationId, { status });
  }

  /**
   * Get agent with business scope included.
   *
   * @param id - The agent ID
   * @param organizationId - The organization ID to filter by
   * @returns The agent with business scope, or null if not found
   */
  async findByIdWithBusinessScope(id: string, organizationId: string): Promise<AgentEntity | null> {
    return this.findById(id, organizationId, {
      include: { business_scope: true },
    });
  }
}

// Export singleton instance
export const agentRepository = new AgentRepository();
