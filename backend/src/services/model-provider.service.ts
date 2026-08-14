/**
 * Model Provider Service
 *
 * CRUD for reusable per-org LLM providers. LiteLLM API keys are stored
 * encrypted in the credential vault; the api_key is never returned to callers.
 */

import { modelProviderRepository, type ModelProviderEntity } from '../repositories/model-provider.repository.js';
import { credentialVaultService } from './credential-vault.service.js';
import { AppError } from '../middleware/errorHandler.js';
import type { CreateModelProviderInput, UpdateModelProviderInput } from '../schemas/model-provider.schema.js';
import { config } from '../config/index.js';

/** Safe (api-facing) view of a provider — never includes the api_key. */
export interface SafeModelProvider {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  defaultModelId: string | null;
  isOrgDefault: boolean;
  hasApiKey: boolean;
  status: string;
  enabled: boolean;
  runtimeCompatible: boolean;
  runtimeCompatibilityReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSafe(row: ModelProviderEntity): SafeModelProvider {
  const runtimeCompatibility = getRuntimeCompatibility(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    defaultModelId: row.default_model_id,
    isOrgDefault: row.is_org_default,
    hasApiKey: !!row.credential_id,
    status: row.status,
    enabled: row.status !== 'disabled',
    runtimeCompatible: runtimeCompatibility.compatible,
    runtimeCompatibilityReason: runtimeCompatibility.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getRuntimeCompatibility(
  row: ModelProviderEntity
): { compatible: boolean; reason: string | null } {
  if (config.agentRuntime !== 'codex' && config.agentRuntime !== 'agentcore') {
    return { compatible: true, reason: null };
  }
  if (row.type !== 'bedrock') {
    return {
      compatible: false,
      reason: 'Codex runtimes do not support the platform LiteLLM provider contract',
    };
  }
  const model = row.default_model_id;
  if (!model || !model.startsWith('openai.gpt-5')) {
    return {
      compatible: false,
      reason: 'Codex on Amazon Bedrock requires a Mantle Responses model (openai.gpt-5*)',
    };
  }
  return { compatible: true, reason: null };
}

/** Credential vault entries backing a litellm provider use this auth_type. */
const VAULT_AUTH_TYPE = 'api_key';

function vaultName(providerName: string): string {
  return `model-provider:${providerName}`;
}

export class ModelProviderService {
  async list(organizationId: string): Promise<SafeModelProvider[]> {
    const rows = await modelProviderRepository.findAll(organizationId);
    return rows.map(toSafe);
  }

  async getById(id: string, organizationId: string): Promise<SafeModelProvider> {
    const row = await modelProviderRepository.findById(id, organizationId);
    if (!row) throw AppError.notFound(`Model provider ${id} not found`);
    return toSafe(row);
  }

  async create(
    organizationId: string,
    input: CreateModelProviderInput,
    createdBy?: string,
  ): Promise<SafeModelProvider> {
    const existing = await modelProviderRepository.findByName(organizationId, input.name);
    if (existing) throw AppError.conflict(`Model provider "${input.name}" already exists`);

    // Store the litellm api_key in the credential vault (encrypted).
    let credentialId: string | null = null;
    if (input.type === 'litellm' && input.api_key) {
      const cred = await credentialVaultService.create(
        organizationId,
        {
          name: vaultName(input.name),
          description: `LiteLLM API key for model provider "${input.name}"`,
          auth_type: VAULT_AUTH_TYPE,
          credential_data: { api_key: input.api_key },
          oauth_scopes: [],
        },
        createdBy,
      );
      credentialId = cred.id;
    }

    if (input.is_org_default) {
      await modelProviderRepository.clearOrgDefault(organizationId);
    }

    const row = await modelProviderRepository.create({
      organization_id: organizationId,
      name: input.name,
      type: input.type,
      base_url: input.base_url ?? null,
      credential_id: credentialId,
      default_model_id: input.default_model_id ?? null,
      is_org_default: input.is_org_default ?? false,
      status: 'active',
      created_by: createdBy ?? null,
    });

    return toSafe(row);
  }

  async update(
    id: string,
    organizationId: string,
    input: UpdateModelProviderInput,
  ): Promise<SafeModelProvider> {
    const existing = await modelProviderRepository.findById(id, organizationId);
    if (!existing) throw AppError.notFound(`Model provider ${id} not found`);

    const data: Partial<ModelProviderEntity> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.base_url !== undefined) data.base_url = input.base_url ?? null;
    if (input.default_model_id !== undefined) data.default_model_id = input.default_model_id ?? null;

    // Rotate the api_key (write-only): create the vault entry if missing, else update it.
    if (input.api_key) {
      if (existing.credential_id) {
        await credentialVaultService.update(existing.credential_id, organizationId, {
          credential_data: { api_key: input.api_key },
        });
      } else {
        const cred = await credentialVaultService.create(organizationId, {
          name: vaultName(input.name ?? existing.name),
          description: `LiteLLM API key for model provider "${input.name ?? existing.name}"`,
          auth_type: VAULT_AUTH_TYPE,
          credential_data: { api_key: input.api_key },
          oauth_scopes: [],
        });
        data.credential_id = cred.id;
      }
    }

    if (input.is_org_default === true) {
      await modelProviderRepository.clearOrgDefault(organizationId);
      data.is_org_default = true;
    } else if (input.is_org_default === false) {
      data.is_org_default = false;
    }

    // Enable/disable via the status column. Any provider may be disabled — but
    // the org must always keep at least one enabled provider, and if the
    // current default is disabled, hand the default to another enabled one.
    if (input.enabled === false) {
      const all = await modelProviderRepository.findAll(organizationId);
      const enabledOthers = all.filter(p => p.id !== id && p.status !== 'disabled');
      if (enabledOthers.length === 0) {
        throw AppError.validation('Cannot disable the last enabled model provider');
      }
      data.status = 'disabled';
      if (existing.is_org_default) {
        // Move default to another enabled provider (prefer a bedrock one).
        const nextDefault = enabledOthers.find(p => p.type === 'bedrock') ?? enabledOthers[0]!;
        data.is_org_default = false;
        await modelProviderRepository.clearOrgDefault(organizationId);
        await modelProviderRepository.update(nextDefault.id, organizationId, { is_org_default: true });
      }
    } else if (input.enabled === true) {
      data.status = 'active';
    }

    const updated = await modelProviderRepository.update(id, organizationId, data);
    if (!updated) throw AppError.notFound(`Model provider ${id} not found`);
    return toSafe(updated);
  }

  async delete(id: string, organizationId: string): Promise<boolean> {
    const existing = await modelProviderRepository.findById(id, organizationId);
    if (!existing) throw AppError.notFound(`Model provider ${id} not found`);
    if (existing.is_org_default) {
      throw AppError.validation('Cannot delete the org default provider; set another default first');
    }

    if (existing.credential_id) {
      try {
        await credentialVaultService.delete(existing.credential_id, organizationId);
      } catch {
        // Vault entry may already be gone; proceed with provider deletion.
      }
    }
    return modelProviderRepository.delete(id, organizationId);
  }

  async setDefault(id: string, organizationId: string): Promise<SafeModelProvider> {
    const existing = await modelProviderRepository.findById(id, organizationId);
    if (!existing) throw AppError.notFound(`Model provider ${id} not found`);
    await modelProviderRepository.clearOrgDefault(organizationId);
    const updated = await modelProviderRepository.update(id, organizationId, { is_org_default: true });
    if (!updated) throw AppError.notFound(`Model provider ${id} not found`);
    return toSafe(updated);
  }
}

export const modelProviderService = new ModelProviderService();
