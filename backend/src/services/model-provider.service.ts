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
import { isCodexBedrockModel } from './model-resolver.js';
import { normalizeLiteLLMBaseUrl } from '../utils/litellm-base-url.js';
import { normalizeCodexBedrockModelId } from '../utils/bedrock-openai-model.js';

/** Safe (api-facing) view of a provider — never includes the api_key. */
export interface SafeModelProvider {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  defaultModelId: string | null;
  allowedModelIds: string[];
  runtimeCompatibleModelIds: string[];
  isOrgDefault: boolean;
  hasApiKey: boolean;
  status: string;
  enabled: boolean;
  runtimeCompatible: boolean;
  runtimeCompatibilityReason: string | null;
  runtimeTarget: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toSafe(row: ModelProviderEntity): SafeModelProvider {
  const runtimeCompatibility = getRuntimeCompatibility(row);
  const allowedModelIds = getAllowedModelIds(row);
  const runtimeCompatibleModelIds = getRuntimeCompatibleModelIds(row);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    baseUrl: row.base_url,
    defaultModelId: row.default_model_id,
    allowedModelIds,
    runtimeCompatibleModelIds,
    isOrgDefault: row.is_org_default,
    hasApiKey: !!row.credential_id,
    status: row.status,
    enabled: row.status !== 'disabled',
    runtimeCompatible: runtimeCompatibility.compatible,
    runtimeCompatibilityReason: runtimeCompatibility.reason,
    runtimeTarget: runtimeCompatibility.target,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllowedModelIds(
  row: Pick<ModelProviderEntity, 'allowed_model_ids' | 'default_model_id'>,
): string[] {
  const configured = row.allowed_model_ids?.length
    ? row.allowed_model_ids
    : row.default_model_id
      ? [row.default_model_id]
      : [];
  return [...new Set(configured.map(modelId => modelId.trim()).filter(Boolean))];
}

export function getRuntimeCompatibleModelIds(
  row: Pick<ModelProviderEntity, 'type' | 'default_model_id' | 'allowed_model_ids'>,
  agentRuntime = config.agentRuntime,
): string[] {
  const allowed = getAllowedModelIds(row);
  if (agentRuntime !== 'codex' && agentRuntime !== 'agentcore') return allowed;
  if (row.type === 'litellm') return allowed;
  return allowed.filter(modelId => isCodexBedrockModel(modelId));
}

export function getRuntimeCompatibility(
  row: Pick<ModelProviderEntity, 'type' | 'default_model_id' | 'allowed_model_ids'>,
  agentRuntime = config.agentRuntime,
): { compatible: boolean; reason: string | null; target: string | null } {
  const compatibleModels = getRuntimeCompatibleModelIds(row, agentRuntime);
  if (agentRuntime !== 'codex' && agentRuntime !== 'agentcore') {
    return compatibleModels.length > 0
      ? { compatible: true, reason: null, target: agentRuntime }
      : { compatible: false, reason: 'No models are enabled for this provider', target: null };
  }
  if (row.type === 'litellm') {
    return compatibleModels.length > 0
      ? { compatible: true, reason: null, target: 'claude' }
      : { compatible: false, reason: 'No models are enabled for this provider', target: null };
  }
  if (compatibleModels.length > 0) {
    return { compatible: true, reason: null, target: agentRuntime };
  }
  return {
    compatible: false,
    reason: row.default_model_id
      ? 'Codex on Amazon Bedrock requires an OpenAI Responses model; use LiteLLM for Claude models'
      : 'Configure an OpenAI Responses model, or use a LiteLLM provider for Claude',
    target: null,
  };
}

function normalizeAllowedModelIds(modelIds: string[] | undefined): string[] {
  return [...new Set((modelIds ?? []).map(modelId => modelId.trim()).filter(Boolean))];
}

function normalizeProviderModelId(type: string, modelId: string | null): string | null {
  if (!modelId || type !== 'bedrock') return modelId;
  return normalizeCodexBedrockModelId(modelId) ?? null;
}

function normalizeProviderModelIds(type: string, modelIds: string[] | undefined): string[] {
  return [...new Set(normalizeAllowedModelIds(modelIds).map(modelId => (
    normalizeProviderModelId(type, modelId) ?? modelId
  )))];
}

function validateDefaultModel(defaultModelId: string | null, allowedModelIds: string[]): void {
  if (defaultModelId && !allowedModelIds.includes(defaultModelId)) {
    throw AppError.validation('The default model must be included in the allowed model list');
  }
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

    const defaultModelId = normalizeProviderModelId(
      input.type,
      input.default_model_id?.trim() || null,
    );
    const allowedModelIds = normalizeProviderModelIds(
      input.type,
      input.allowed_model_ids ?? (defaultModelId ? [defaultModelId] : []),
    );
    validateDefaultModel(defaultModelId, allowedModelIds);
    if (input.is_org_default) {
      const candidate = {
        type: input.type,
        default_model_id: defaultModelId,
        allowed_model_ids: allowedModelIds,
      };
      if (!getRuntimeCompatibility(candidate).compatible) {
        throw AppError.validation('The organization default provider must have at least one runtime-compatible model');
      }
    }

    const row = await modelProviderRepository.create({
      organization_id: organizationId,
      name: input.name,
      type: input.type,
      base_url:
        input.type === 'litellm' && input.base_url
          ? normalizeLiteLLMBaseUrl(input.base_url)
          : null,
      credential_id: credentialId,
      default_model_id: defaultModelId,
      allowed_model_ids: allowedModelIds,
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
    if (input.base_url !== undefined) {
      if (existing.type === 'litellm' && !input.base_url) {
        throw AppError.validation('base_url is required for litellm providers');
      }
      data.base_url = input.base_url
        ? normalizeLiteLLMBaseUrl(input.base_url)
        : null;
    }
    const effectiveDefaultModelId =
      input.default_model_id !== undefined
        ? normalizeProviderModelId(existing.type, input.default_model_id?.trim() || null)
        : existing.default_model_id;
    let effectiveAllowedModelIds =
      input.allowed_model_ids !== undefined
        ? normalizeProviderModelIds(existing.type, input.allowed_model_ids)
        : getAllowedModelIds(existing);
    if (
      input.default_model_id !== undefined &&
      input.allowed_model_ids === undefined &&
      effectiveDefaultModelId &&
      !effectiveAllowedModelIds.includes(effectiveDefaultModelId)
    ) {
      effectiveAllowedModelIds = [...effectiveAllowedModelIds, effectiveDefaultModelId];
    }
    validateDefaultModel(effectiveDefaultModelId, effectiveAllowedModelIds);
    if (input.default_model_id !== undefined) data.default_model_id = effectiveDefaultModelId;
    if (input.allowed_model_ids !== undefined || input.default_model_id !== undefined) {
      data.allowed_model_ids = effectiveAllowedModelIds;
    }

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
      const candidate = {
        ...existing,
        ...data,
        default_model_id: effectiveDefaultModelId,
        allowed_model_ids: effectiveAllowedModelIds,
      };
      if (!getRuntimeCompatibility(candidate).compatible) {
        throw AppError.validation('The organization default provider must have at least one runtime-compatible model');
      }
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
    if (!getRuntimeCompatibility(existing).compatible) {
      throw AppError.validation('The organization default provider must have at least one runtime-compatible model');
    }
    await modelProviderRepository.clearOrgDefault(organizationId);
    const updated = await modelProviderRepository.update(id, organizationId, { is_org_default: true });
    if (!updated) throw AppError.notFound(`Model provider ${id} not found`);
    return toSafe(updated);
  }
}

export const modelProviderService = new ModelProviderService();
