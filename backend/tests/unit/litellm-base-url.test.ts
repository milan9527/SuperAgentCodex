import { describe, expect, it } from 'vitest';
import { normalizeLiteLLMBaseUrl } from '../../src/utils/litellm-base-url.js';

describe('normalizeLiteLLMBaseUrl', () => {
  it.each([
    ['https://litellm.example.com/', 'https://litellm.example.com'],
    ['https://litellm.example.com/ui/', 'https://litellm.example.com'],
    ['https://litellm.example.com/ui/settings', 'https://litellm.example.com'],
    ['https://litellm.example.com/v1', 'https://litellm.example.com'],
    ['https://litellm.example.com/v1/messages', 'https://litellm.example.com'],
    ['https://litellm.example.com/model/info', 'https://litellm.example.com'],
    ['https://example.com/gateway/ui/', 'https://example.com/gateway'],
    ['https://example.com/gateway/v1/messages', 'https://example.com/gateway'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeLiteLLMBaseUrl(input)).toBe(expected);
  });

  it('removes query strings and fragments', () => {
    expect(
      normalizeLiteLLMBaseUrl('https://litellm.example.com/ui/?tab=models#provider'),
    ).toBe('https://litellm.example.com');
  });
});
