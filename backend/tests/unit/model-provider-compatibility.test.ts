import { describe, expect, it } from 'vitest';
import type { ModelProviderEntity } from '../../src/repositories/model-provider.repository.js';
import {
  getAllowedModelIds,
  getRuntimeCompatibility,
} from '../../src/services/model-provider.service.js';

function provider(
  type: 'bedrock' | 'litellm',
  defaultModelId: string | null,
): ModelProviderEntity {
  return {
    id: 'provider-1',
    organization_id: 'org-1',
    name: 'Provider',
    type,
    base_url: type === 'litellm' ? 'https://litellm.example.com' : null,
    credential_id: null,
    default_model_id: defaultModelId,
    allowed_model_ids: defaultModelId ? [defaultModelId] : [],
    is_org_default: false,
    status: 'active',
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('model provider runtime compatibility', () => {
  it('exposes the configured default model when a legacy allowlist is empty', () => {
    expect(getAllowedModelIds({
      default_model_id: 'openai.gpt-5.4',
      allowed_model_ids: [],
    })).toEqual(['openai.gpt-5.4']);
  });

  it('accepts Bedrock OpenAI Responses models for Codex', () => {
    expect(
      getRuntimeCompatibility(provider('bedrock', 'openai.gpt-5.4'), 'agentcore'),
    ).toEqual({ compatible: true, reason: null, target: 'agentcore' });
  });

  it('accepts AWS global inference-profile aliases for GPT 5.6', () => {
    expect(
      getRuntimeCompatibility(provider('bedrock', 'global.openai.gpt-5.6-sol'), 'agentcore'),
    ).toEqual({ compatible: true, reason: null, target: 'agentcore' });
  });

  it('accepts LiteLLM providers and routes their model list to Claude', () => {
    expect(
      getRuntimeCompatibility(
        provider('litellm', 'anthropic/claude-sonnet-4-6'),
        'agentcore',
      ),
    ).toEqual({ compatible: true, reason: null, target: 'claude' });
  });

  it('rejects direct Bedrock Claude in Codex mode', () => {
    const result = getRuntimeCompatibility(
      provider('bedrock', 'us.anthropic.claude-sonnet-4-6'),
      'agentcore',
    );

    expect(result.compatible).toBe(false);
    expect(result.target).toBeNull();
    expect(result.reason).toContain('use LiteLLM for Claude');
  });
});
