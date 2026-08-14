/**
 * AgentCore Registry Service
 *
 * Wraps AWS Bedrock AgentCore Registry APIs for agent/skill/MCP registration,
 * discovery, and A2A protocol support.
 *
 * Design:
 *   - Lazy SDK loading (same pattern as agentcore.service.ts)
 *   - Non-blocking: sync failures don't break local operations
 *   - Config-driven: disabled when AGENTCORE_REGISTRY_ENABLED is false
 *
 * Used by:
 *   - agent.service.ts — sync agents to Registry on A2A enable
 *   - swarm-orchestrator.service.ts — Smart Agent Selection via semantic search
 *   - a2a.routes.ts — Agent Card discovery endpoint
 */

import { config } from '../config/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DescriptorType = 'MCP' | 'A2A' | 'AGENT_SKILLS';

export interface RegistryRecord {
  recordId: string;
  recordArn: string;
  name: string;
  descriptorType: DescriptorType;
  status: string;
  description?: string;
  descriptors?: Record<string, unknown>;
  recordVersion?: string;
}

export interface CreateRecordParams {
  name: string;
  descriptorType: DescriptorType;
  descriptors: Record<string, unknown>;
  description?: string;
  version?: string;
}

export interface ServiceResult<T> {
  data: T | null;
  error: string | null;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class AgentCoreRegistryService {
  private controlClient: any;
  private dataClient: any;
  private sdkLoaded = false;

  // ── SDK lifecycle ─────────────────────────────────────────────────────────

  private get registryConfig() {
    return (config as any).agentcore?.registry;
  }

  get enabled(): boolean {
    return !!this.registryConfig?.enabled;
  }

  get registryId(): string | undefined {
    return this.registryConfig?.defaultRegistryId;
  }

  get registryArn(): string | undefined {
    return this.registryConfig?.defaultRegistryArn;
  }

  /**
   * Lazily load AWS SDK clients.
   * Follows the same pattern as agentcore.service.ts — dev environments
   * without AWS credentials can still start the server.
   */
  private async ensureSDK(): Promise<void> {
    if (this.sdkLoaded) return;

    if (!this.enabled) {
      throw new Error('AgentCore Registry is not enabled');
    }

    try {
      const ctrlMod = await import('@aws-sdk/client-bedrock-agentcore-control' as string);
      const dataMod = await import('@aws-sdk/client-bedrock-agentcore' as string);
      const region = this.registryConfig?.region || config.aws.region || 'us-east-1';

      this.controlClient = new ctrlMod.BedrockAgentCoreControl({ region });
      this.dataClient = new dataMod.BedrockAgentCore({ region });
      this.sdkLoaded = true;
    } catch (err) {
      throw new Error(
        `AgentCore Registry SDK not available. Install @aws-sdk/client-bedrock-agentcore-control. Error: ${err}`,
      );
    }
  }

  // ── Registry CRUD ─────────────────────────────────────────────────────────

  async createRegistry(
    name: string,
    opts?: { description?: string; autoApproval?: boolean },
  ): Promise<ServiceResult<{ registryArn: string }>> {
    try {
      await this.ensureSDK();
      const resp = await this.controlClient.createRegistry({
        name,
        description: opts?.description,
        approvalConfiguration: { autoApproval: opts?.autoApproval ?? false },
        authorizerType: 'AWS_IAM',
      });
      return { data: { registryArn: resp.registryArn }, error: null };
    } catch (err: any) {
      console.warn('[registry] createRegistry failed:', err.message);
      return { data: null, error: err.message };
    }
  }

  async listRegistries(): Promise<ServiceResult<any[]>> {
    try {
      await this.ensureSDK();
      const resp = await this.controlClient.listRegistries();
      return { data: resp.registries ?? [], error: null };
    } catch (err: any) {
      return { data: [], error: err.message };
    }
  }

  // ── Record CRUD ───────────────────────────────────────────────────────────

  /**
   * Register an Agent/MCP/Skill to AgentCore Registry.
   */
  async createRecord(
    registryId: string,
    params: CreateRecordParams,
  ): Promise<ServiceResult<{ recordId: string; recordArn: string; status: string }>> {
    try {
      await this.ensureSDK();
      const resp = await this.controlClient.createRegistryRecord({
        registryId,
        name: params.name,
        descriptorType: params.descriptorType,
        descriptors: params.descriptors,
        recordVersion: params.version || '1.0',
        description: params.description,
      });
      const recArn: string = resp.recordArn ?? '';
      const recId = recArn.includes('/') ? recArn.split('/').pop()! : '';
      console.log(`[registry] Created record ${params.name} → ${recId}`);
      return {
        data: { recordId: recId, recordArn: recArn, status: resp.status ?? 'DRAFT' },
        error: null,
      };
    } catch (err: any) {
      console.warn(`[registry] createRecord failed for ${params.name}:`, err.message);
      return { data: null, error: err.message };
    }
  }

  async getRecord(
    registryId: string,
    recordId: string,
  ): Promise<ServiceResult<RegistryRecord>> {
    try {
      await this.ensureSDK();
      const resp = await this.controlClient.getRegistryRecord({ registryId, recordId });
      return { data: resp as RegistryRecord, error: null };
    } catch (err: any) {
      return { data: null, error: err.message };
    }
  }

  async updateRecord(
    registryId: string,
    recordId: string,
    params: Partial<Pick<CreateRecordParams, 'description' | 'version' | 'descriptors'>>,
  ): Promise<ServiceResult<RegistryRecord>> {
    try {
      await this.ensureSDK();
      const kwargs: Record<string, unknown> = { registryId, recordId };
      if (params.description != null) kwargs.description = params.description;
      if (params.version != null) kwargs.recordVersion = params.version;
      if (params.descriptors != null) kwargs.descriptors = params.descriptors;
      const resp = await this.controlClient.updateRegistryRecord(kwargs);
      return { data: resp as RegistryRecord, error: null };
    } catch (err: any) {
      console.warn(`[registry] updateRecord failed for ${recordId}:`, err.message);
      return { data: null, error: err.message };
    }
  }

  async deleteRecord(registryId: string, recordId: string): Promise<boolean> {
    try {
      await this.ensureSDK();
      await this.controlClient.deleteRegistryRecord({ registryId, recordId });
      console.log(`[registry] Deleted record ${recordId}`);
      return true;
    } catch (err: any) {
      console.warn(`[registry] deleteRecord failed for ${recordId}:`, err.message);
      return false;
    }
  }

  async listRecords(registryId: string): Promise<RegistryRecord[]> {
    try {
      await this.ensureSDK();
      const resp = await this.controlClient.listRegistryRecords({ registryId });
      return resp.registryRecords ?? [];
    } catch {
      return [];
    }
  }

  // ── Semantic Search (core capability) ─────────────────────────────────────

  /**
   * Hybrid semantic + keyword search across registry records.
   *
   * Uses the bedrock-agentcore data plane API (not control plane).
   * Only returns APPROVED records.
   *
   * Use cases:
   *   1. Agents page — discover agents across scopes
   *   2. Swarm orchestration — Smart Agent Selection
   *   3. Tools page — semantic skill search
   *   4. Chat routing — find best agent for a message
   */
  async searchRecords(
    registryArn: string,
    query: string,
    maxResults = 5,
  ): Promise<ServiceResult<RegistryRecord[]>> {
    try {
      await this.ensureSDK();
      const resp = await this.dataClient.searchRegistryRecords({
        registryIds: [registryArn],
        searchQuery: query,
        maxResults,
      });
      const records = resp.registryRecords ?? [];
      console.log(`[registry] Search "${query.substring(0, 50)}" → ${records.length} results`);
      return { data: records, error: null };
    } catch (err: any) {
      console.warn(`[registry] searchRecords failed:`, err.message);
      return { data: [], error: err.message };
    }
  }

  // ── A2A Agent Card helpers ────────────────────────────────────────────────

  /**
   * Build an A2A Agent Card descriptor for registration.
   */
  buildA2ADescriptors(agent: {
    id: string;
    name: string;
    display_name: string;
    role?: string;
    organization_id: string;
    business_scope_id?: string;
    a2a_capabilities?: string;
    skills?: Array<{ id: string; name: string; description?: string }>;
  }): Record<string, unknown> {
    return {
      agentCard: {
        protocolVersion: '0.3',
        name: agent.name,
        displayName: agent.display_name,
        description: agent.a2a_capabilities || agent.role || '',
        url: `${config.appUrl}/api/a2a/agents/${agent.id}`,
        capabilities: {
          streaming: true,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        authentication: {
          schemes: ['bearer'],
        },
        defaultInputModes: ['text'],
        defaultOutputModes: ['text'],
        skills: (agent.skills ?? []).map(s => ({
          id: s.id,
          name: s.name,
          description: s.description || '',
        })),
      },
      platform: {
        agentId: agent.id,
        organizationId: agent.organization_id,
        scopeId: agent.business_scope_id,
      },
    };
  }

  /**
   * Register or update an agent's A2A record in the Registry.
   * Returns the record ID and ARN, or null if Registry is not enabled.
   */
  async syncAgentA2A(
    agent: Parameters<AgentCoreRegistryService['buildA2ADescriptors']>[0],
    exposedSkillIds?: string[],
  ): Promise<{ recordId: string; recordArn: string } | null> {
    if (!this.enabled || !this.registryId) return null;

    const filteredAgent = { ...agent };
    if (exposedSkillIds && agent.skills) {
      filteredAgent.skills = agent.skills.filter(s => exposedSkillIds.includes(s.id));
    }

    const descriptors = this.buildA2ADescriptors(filteredAgent);
    const result = await this.createRecord(this.registryId, {
      name: `a2a-${agent.name}`,
      descriptorType: 'A2A',
      descriptors,
      description: agent.a2a_capabilities || agent.role || agent.display_name,
      version: '1.0',
    });

    return result.data ? { recordId: result.data.recordId, recordArn: result.data.recordArn } : null;
  }

  /**
   * Remove an agent's A2A record from the Registry.
   */
  async removeAgentA2A(recordId: string): Promise<boolean> {
    if (!this.enabled || !this.registryId || !recordId) return false;
    return this.deleteRecord(this.registryId, recordId);
  }
}

export const agentCoreRegistryService = new AgentCoreRegistryService();
