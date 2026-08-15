/**
 * Model Provider schemas
 *
 * A model provider is a reusable, per-org LLM endpoint config: either Amazon
 * Bedrock (uses the platform's AWS creds) or a LiteLLM-compatible gateway
 * (base_url + api_key + optional default model). The api_key is stored
 * encrypted in the credential vault and is write-only over the API.
 */

import { z } from 'zod';

export const modelProviderTypeSchema = z.enum(['bedrock', 'litellm']);

export const createModelProviderSchema = z
  .object({
    name: z.string().min(1).max(255),
    type: modelProviderTypeSchema,
    base_url: z.string().url().max(1024).optional().nullable(),
    /** Plain-text LiteLLM API key — encrypted server-side, never returned. */
    api_key: z.string().min(1).optional().nullable(),
    default_model_id: z.string().max(255).optional().nullable(),
    allowed_model_ids: z.array(z.string().min(1).max(255)).max(100).optional(),
    is_org_default: z.boolean().optional().default(false),
  })
  .refine((v) => v.type !== 'litellm' || !!v.base_url, {
    message: 'base_url is required for litellm providers',
    path: ['base_url'],
  });

export const updateModelProviderSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  base_url: z.string().url().max(1024).optional().nullable(),
  /** When present (non-empty), re-encrypts and replaces the stored key. */
  api_key: z.string().min(1).optional().nullable(),
  default_model_id: z.string().max(255).optional().nullable(),
  allowed_model_ids: z.array(z.string().min(1).max(255)).max(100).optional(),
  is_org_default: z.boolean().optional(),
  /** Enable/disable: disabled providers are hidden from scope/agent/chat pickers and skipped by the resolver. */
  enabled: z.boolean().optional(),
});

export type CreateModelProviderInput = z.infer<typeof createModelProviderSchema>;
export type UpdateModelProviderInput = z.infer<typeof updateModelProviderSchema>;

/** Model selection stored on agent.model_config and scope.settings. */
export interface ModelSelection {
  providerId?: string;
  modelId?: string;
}
