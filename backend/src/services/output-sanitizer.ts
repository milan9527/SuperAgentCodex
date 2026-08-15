/**
 * Output Sanitizer
 *
 * Strips sensitive server-side information from agent responses before
 * they reach the client. Runs as the last step before SSE serialization.
 *
 * Targets:
 *   - Absolute workspace paths (e.g. /Users/fredzh/Downloads/.../workspaces/...)
 *   - Home directory paths
 *   - Internal env vars (API_BASE_URL, AUTH_TOKEN)
 *   - AWS credentials if accidentally echoed
 */

import { config } from '../config/index.js';
import { homedir } from 'os';
import type { ConversationEvent, ContentBlock } from './claude-agent.service.js';

/** Patterns to strip, ordered from most specific to least. */
function buildPatterns(): { pattern: RegExp; replacement: string }[] {
  const patterns: { pattern: RegExp; replacement: string }[] = [];

  // Workspace base dir (most specific — must come first)
  const wsBase = config.claude.workspaceBaseDir;
  if (wsBase) {
    // Match the full session workspace path: base/orgId/scopeId/sessions/sessionId
    patterns.push({
      pattern: new RegExp(escapeRegex(wsBase) + '/[a-f0-9-]+/[a-f0-9-]+/sessions/[a-f0-9-]+', 'g'),
      replacement: '/workspace',
    });
    // Match the base dir itself with any trailing path
    patterns.push({
      pattern: new RegExp(escapeRegex(wsBase) + '[^\\s"\'`]*', 'g'),
      replacement: '/workspace',
    });
  }

  // Home directory
  const home = homedir();
  if (home) {
    patterns.push({
      pattern: new RegExp(escapeRegex(home) + '[^\\s"\'`]*', 'g'),
      replacement: '~',
    });
  }

  // Generic absolute paths that look like server paths
  // /Users/..., /home/..., /var/..., /tmp/..., /opt/...
  patterns.push({
    pattern: /\/(?:Users|home|var|tmp|opt)\/[^\s"'`]+/g,
    replacement: '[server-path]',
  });

  // Internal tokens / env vars that might be echoed
  patterns.push({
    pattern: /(AUTH_TOKEN|API_KEY|OPENAI_API_KEY|AWS_BEARER_TOKEN_BEDROCK)=[^\s"'`]+/g,
    replacement: '$1=[REDACTED]',
  });
  patterns.push({
    pattern: /(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|AWS_SESSION_TOKEN)=[^\s"'`]+/g,
    replacement: '$1=[REDACTED]',
  });
  patterns.push({
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: 'Bearer [REDACTED]',
  });
  patterns.push({
    pattern: /\b(?:sk|sess)-[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  });
  patterns.push({
    pattern: /"(backend_api_key|api_key|authorization|auth_token)"\s*:\s*"[^"]*"/gi,
    replacement: '"$1":"[REDACTED]"',
  });

  return patterns;
}

let cachedPatterns: ReturnType<typeof buildPatterns> | null = null;

function getPatterns() {
  if (!cachedPatterns) cachedPatterns = buildPatterns();
  return cachedPatterns;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Sanitize a single string value. */
export function sanitizeString(text: string): string {
  let result = text;
  for (const { pattern, replacement } of getPatterns()) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Sanitize a content block in-place. Returns a new block. */
function sanitizeContentBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { ...block, text: sanitizeString(block.text) };
    case 'tool_use':
      return {
        ...block,
        input: JSON.parse(sanitizeString(JSON.stringify(block.input))),
      };
    case 'tool_result':
      return {
        ...block,
        content: block.content ? sanitizeString(block.content) : '',
      };
    default:
      return block;
  }
}

/** Sanitize a full conversation event. Returns a new event. */
export function sanitizeEvent(event: ConversationEvent): ConversationEvent {
  if (event.type === 'assistant' && event.content) {
    return {
      ...event,
      content: event.content.map(sanitizeContentBlock),
    };
  }
  if (event.type === 'error' && event.message) {
    return {
      ...event,
      message: sanitizeString(event.message),
    };
  }
  return event;
}
