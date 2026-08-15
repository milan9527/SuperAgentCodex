import { describe, expect, it } from 'vitest';
import {
  isCodexBedrockModelId,
  normalizeCodexBedrockModelId,
} from '../../src/utils/bedrock-openai-model.js';

describe('Bedrock OpenAI model normalization', () => {
  it.each([
    ['openai.gpt-5.6-sol', 'openai.gpt-5.6-sol'],
    ['global.openai.gpt-5.6-sol', 'openai.gpt-5.6-sol'],
    ['us.openai.gpt-5.6-terra', 'openai.gpt-5.6-terra'],
    ['eu.openai.gpt-5.6-luna', 'openai.gpt-5.6-luna'],
    ['gpt-5.6-sol', 'openai.gpt-5.6-sol'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeCodexBedrockModelId(input)).toBe(expected);
    expect(isCodexBedrockModelId(input)).toBe(true);
  });

  it('does not reinterpret direct Bedrock Claude as a Codex model', () => {
    expect(normalizeCodexBedrockModelId('global.anthropic.claude-opus-4-8'))
      .toBe('global.anthropic.claude-opus-4-8');
    expect(isCodexBedrockModelId('global.anthropic.claude-opus-4-8')).toBe(false);
  });
});
