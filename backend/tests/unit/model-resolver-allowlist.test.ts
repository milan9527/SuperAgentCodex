import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findOrgDefault: vi.fn(),
  decryptCredential: vi.fn(),
}));

vi.mock('../../src/repositories/model-provider.repository.js', () => ({
  modelProviderRepository: {
    findById: mocks.findById,
    findOrgDefault: mocks.findOrgDefault,
  },
}));

vi.mock('../../src/services/credential-vault.service.js', () => ({
  credentialVaultService: {
    decryptCredential: mocks.decryptCredential,
  },
}));

import { resolveModel } from '../../src/services/model-resolver.js';

const litellmProvider = {
  id: 'provider-1',
  organization_id: 'org-1',
  name: 'Approved LiteLLM',
  type: 'litellm',
  base_url: 'https://litellm.example.com',
  credential_id: 'credential-1',
  default_model_id: 'claude-sonnet-4.6',
  allowed_model_ids: ['claude-sonnet-4.6', 'claude-haiku-4.5'],
  is_org_default: true,
  status: 'active',
  created_by: null,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockResolvedValue(litellmProvider);
  mocks.findOrgDefault.mockResolvedValue(litellmProvider);
  mocks.decryptCredential.mockResolvedValue({ api_key: 'secret' });
});

describe('model resolver allowlist', () => {
  it('resolves a model explicitly enabled by Admin Settings', async () => {
    await expect(resolveModel('org-1', {
      requestSelection: {
        providerId: 'provider-1',
        modelId: 'claude-haiku-4.5',
      },
    })).resolves.toEqual({
      provider: 'litellm',
      baseUrl: 'https://litellm.example.com',
      apiKey: 'secret',
      modelId: 'claude-haiku-4.5',
    });
  });

  it('rejects a live LiteLLM model that is not enabled by Admin Settings', async () => {
    await expect(resolveModel('org-1', {
      requestSelection: {
        providerId: 'provider-1',
        modelId: 'claude-opus-4.8',
      },
    })).rejects.toMatchObject({
      statusCode: 400,
      message: 'Model "claude-opus-4.8" is not enabled for provider "Approved LiteLLM"',
    });
  });

  it('uses the provider default only when it is in the allowlist', async () => {
    await expect(resolveModel('org-1', {
      requestSelection: { providerId: 'provider-1' },
    })).resolves.toMatchObject({
      provider: 'litellm',
      modelId: 'claude-sonnet-4.6',
    });
  });
});
