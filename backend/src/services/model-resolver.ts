/**
 * Model Resolver
 *
 * Collapses a (request / scope / agent) model selection into a single
 * ResolvedModel that the runtimes can act on. For litellm providers the
 * api_key is decrypted from the credential vault here — it must never be
 * persisted outside the vault, logged, or returned to the frontend.
 */

import { modelProviderRepository } from '../repositories/model-provider.repository.js';
import { credentialVaultService } from './credential-vault.service.js';
import type { ModelSelection } from '../schemas/model-provider.schema.js';
import { AppError } from '../middleware/errorHandler.js';

export interface ResolvedModel {
  provider: 'bedrock' | 'litellm';
  /** Model id to use (bedrock model id or litellm model name). May be undefined → runtime default. */
  modelId?: string;
  /** litellm only */
  baseUrl?: string;
  /** litellm only — decrypted secret */
  apiKey?: string;
}

interface ResolveInput {
  requestSelection?: ModelSelection | null;
  scopeSelection?: ModelSelection | null;
  agentSelection?: ModelSelection | null;
}

/** Codex's Bedrock provider requires an OpenAI Responses-compatible model. */
export function isCodexBedrockModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const id = modelId.toLowerCase();
  return id.startsWith('openai.gpt-5') || id.startsWith('gpt-5');
}

/**
 * Extracts a ModelSelection from a stored JSON blob (scope.settings or
 * agent.model_config), tolerating the legacy flat `modelId` string shape.
 */
export function extractSelection(blob: unknown): ModelSelection | null {
  if (!blob || typeof blob !== 'object') return null;
  const obj = blob as Record<string, unknown>;
  const nested = obj.modelSelection as Record<string, unknown> | undefined;
  if (nested && typeof nested === 'object') {
    return {
      providerId: typeof nested.providerId === 'string' ? nested.providerId : undefined,
      modelId: typeof nested.modelId === 'string' ? nested.modelId : undefined,
    };
  }
  // Legacy: a bare modelId string with no provider (resolves via org default).
  if (typeof obj.modelId === 'string' && obj.modelId) {
    return { modelId: obj.modelId };
  }
  return null;
}

/** Picks the first selection that carries any information (provider or model). */
function pickSelection(input: ResolveInput): ModelSelection | null {
  for (const sel of [input.requestSelection, input.scopeSelection, input.agentSelection]) {
    if (sel && (sel.providerId || sel.modelId)) return sel;
  }
  return null;
}

/**
 * Resolve the effective model for an invocation. Falls back to the org default
 * provider, and ultimately to a bedrock config default so a chat never fails
 * purely due to missing model config.
 */
export async function resolveModel(
  organizationId: string,
  input: ResolveInput,
): Promise<ResolvedModel> {
  const selection = pickSelection(input);

  // Determine which provider to use: explicit selection → org default → implicit bedrock.
  let provider = selection?.providerId
    ? await modelProviderRepository.findById(selection.providerId, organizationId)
    : await modelProviderRepository.findOrgDefault(organizationId);
  let selectedModelId = selection?.modelId;

  // A disabled provider (e.g. one that was turned off after being assigned to a
  // scope/agent) falls back to the org default so chats keep working.
  if (provider && provider.status === 'disabled') {
    provider = await modelProviderRepository.findOrgDefault(organizationId);
    selectedModelId = undefined;
  }

  // No provider row at all (e.g. brand-new org before seed): bedrock default.
  // Leave modelId undefined when unspecified so the runtime applies its own
  // valid default (local: getBedrockModelId(config.claude.model); container:
  // its ANTHROPIC_MODEL env) rather than a possibly-unresolvable alias.
  if (!provider) {
    return { provider: 'bedrock', modelId: selectedModelId };
  }

  const allowedModelIds = provider.allowed_model_ids?.length
    ? provider.allowed_model_ids
    : provider.default_model_id
      ? [provider.default_model_id]
      : [];
  const modelId = selectedModelId ?? provider.default_model_id ?? undefined;
  if (!modelId || !allowedModelIds.includes(modelId)) {
    throw AppError.validation(
      modelId
        ? `Model "${modelId}" is not enabled for provider "${provider.name}"`
        : `Provider "${provider.name}" has no enabled default model`,
    );
  }

  if (provider.type === 'litellm') {
    let apiKey: string | undefined;
    if (provider.credential_id) {
      try {
        const data = await credentialVaultService.decryptCredential(provider.credential_id, organizationId);
        apiKey = typeof data.api_key === 'string' ? data.api_key : undefined;
      } catch {
        // Missing/unreadable key — leave undefined; the gateway call will fail loudly.
      }
    }
    return {
      provider: 'litellm',
      baseUrl: provider.base_url ?? undefined,
      apiKey,
      modelId,
    };
  }

  // bedrock — use explicit selection or the provider's configured default;
  // otherwise leave undefined so the runtime picks its own valid default.
  return {
    provider: 'bedrock',
    modelId,
  };
}
