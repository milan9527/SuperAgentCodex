/**
 * Bedrock Models Service
 *
 * Lists the models available to invoke in the configured AWS region:
 * inference profiles (the ids Claude Code / Bedrock expects, e.g.
 * us.anthropic.claude-opus-4-8) plus on-demand foundation models. Results are
 * cached briefly so the UI "refresh" is cheap without hammering the API.
 */

import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';
import { config } from '../config/index.js';

export interface BedrockModel {
  /** The id to pass as the model (inference profile id or foundation model id). */
  id: string;
  /** Display name. */
  name: string;
  provider: string;
}

let client: BedrockClient | null = null;
function getClient(): BedrockClient {
  if (!client) client = new BedrockClient({ region: config.aws.region });
  return client;
}

interface CacheEntry { at: number; models: BedrockModel[] }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Extract a provider label from an inference-profile / model id. */
function providerOf(id: string): string {
  // e.g. "us.anthropic.claude-opus-4-8" → "anthropic"; "amazon.titan..." → "amazon"
  const parts = id.split('.');
  if ((parts[0] === 'us' || parts[0] === 'eu' || parts[0] === 'apac' || parts[0] === 'global') && parts[1]) {
    return parts[1];
  }
  return parts[0] || 'bedrock';
}

export async function listBedrockModels(force = false): Promise<BedrockModel[]> {
  const region = config.aws.region;
  const cached = cache.get(region);
  if (!force && cached && Date.now() - cached.at < TTL_MS) {
    return cached.models;
  }

  const c = getClient();
  const byId = new Map<string, BedrockModel>();

  // Inference profiles are the canonical invoke ids (cross-region routed).
  try {
    const profiles = await c.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
    for (const p of profiles.inferenceProfileSummaries ?? []) {
      const id = p.inferenceProfileId;
      if (!id) continue;
      byId.set(id, { id, name: p.inferenceProfileName || id, provider: providerOf(id) });
    }
  } catch (err) {
    console.warn('[bedrock-models] ListInferenceProfiles failed:', err instanceof Error ? err.message : err);
  }

  // On-demand foundation models (text) that aren't already covered by a profile.
  try {
    const fms = await c.send(new ListFoundationModelsCommand({ byOutputModality: 'TEXT' }));
    for (const m of fms.modelSummaries ?? []) {
      const id = m.modelId;
      if (!id) continue;
      const onDemand = (m.inferenceTypesSupported ?? []).includes('ON_DEMAND');
      if (!onDemand) continue; // profile-only models are already listed above
      if (!byId.has(id)) {
        byId.set(id, { id, name: m.modelName || id, provider: m.providerName || providerOf(id) });
      }
    }
  } catch (err) {
    console.warn('[bedrock-models] ListFoundationModels failed:', err instanceof Error ? err.message : err);
  }

  // Sort: anthropic first, then by id.
  const models = [...byId.values()].sort((a, b) => {
    const aa = a.provider.toLowerCase() === 'anthropic' ? 0 : 1;
    const bb = b.provider.toLowerCase() === 'anthropic' ? 0 : 1;
    return aa !== bb ? aa - bb : a.id.localeCompare(b.id);
  });

  cache.set(region, { at: Date.now(), models });
  return models;
}
