const LITELLM_ENDPOINT_SUFFIXES = [
  /\/ui(?:\/.*)?$/i,
  /\/v1\/messages$/i,
  /\/v1\/models$/i,
  /\/model\/info$/i,
  /\/v1$/i,
];

/**
 * Convert an admin-facing LiteLLM URL into the proxy root expected by
 * Anthropic-compatible clients. Deployment prefixes are preserved.
 */
export function normalizeLiteLLMBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  url.search = '';
  url.hash = '';

  let pathname = url.pathname.replace(/\/+$/, '');
  for (const suffix of LITELLM_ENDPOINT_SUFFIXES) {
    if (suffix.test(pathname)) {
      pathname = pathname.replace(suffix, '');
      break;
    }
  }

  url.pathname = pathname || '/';
  return url.toString().replace(/\/+$/, '');
}
