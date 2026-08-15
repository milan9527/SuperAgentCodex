const BEDROCK_PROFILE_PREFIXES = ['global.', 'us.', 'eu.', 'apac.'] as const;

/**
 * Convert Bedrock inference-profile aliases into the canonical OpenAI model
 * identifier expected by Codex's Amazon Bedrock provider.
 */
export function normalizeCodexBedrockModelId(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;

  let normalized = modelId.trim();
  const lower = normalized.toLowerCase();
  const prefix = BEDROCK_PROFILE_PREFIXES.find(candidate => (
    lower.startsWith(`${candidate}openai.gpt-5`)
  ));
  if (prefix) {
    normalized = normalized.slice(prefix.length);
  }

  if (normalized.toLowerCase().startsWith('gpt-5')) {
    normalized = `openai.${normalized}`;
  }
  return normalized;
}

export function isCodexBedrockModelId(modelId: string | undefined): boolean {
  return normalizeCodexBedrockModelId(modelId)?.toLowerCase().startsWith('openai.gpt-5') ?? false;
}
