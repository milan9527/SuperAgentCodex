import { describe, expect, it } from 'vitest';
import { sanitizeEvent, sanitizeString } from '../../src/services/output-sanitizer.js';

describe('output sanitizer', () => {
  it('redacts provider, AWS, bearer, and internal JSON credentials', () => {
    const value = [
      'AUTH_TOKEN=internal-secret',
      'AWS_ACCESS_KEY_ID=AKIAEXAMPLE',
      'AWS_SECRET_ACCESS_KEY=secret-value',
      'AWS_SESSION_TOKEN=session-value',
      'OPENAI_API_KEY=sk-example123456789012345',
      'Authorization: Bearer abc.def.ghi-jklmnop',
      '{"backend_api_key":"jwt-secret","authorization":"Bearer hidden"}',
    ].join(' ');

    const sanitized = sanitizeString(value);

    expect(sanitized).not.toContain('internal-secret');
    expect(sanitized).not.toContain('AKIAEXAMPLE');
    expect(sanitized).not.toContain('secret-value');
    expect(sanitized).not.toContain('session-value');
    expect(sanitized).not.toContain('sk-example123456789012345');
    expect(sanitized).not.toContain('abc.def.ghi-jklmnop');
    expect(sanitized).not.toContain('jwt-secret');
    expect(sanitized).toContain('AWS_ACCESS_KEY_ID=[REDACTED]');
    expect(sanitized).toContain('Bearer [REDACTED]');
  });

  it('sanitizes native Codex tool inputs and error messages before SSE', () => {
    const toolEvent = sanitizeEvent({
      type: 'assistant',
      provider: 'codex',
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: {
          command: 'echo AUTH_TOKEN=secret-token',
          authorization: 'Bearer abcdefghijklmnop',
        },
      }],
    });
    const errorEvent = sanitizeEvent({
      type: 'error',
      provider: 'codex',
      message: 'failed under /home/ec2-user/private with AWS_SECRET_ACCESS_KEY=secret',
    });

    expect(JSON.stringify(toolEvent)).not.toContain('secret-token');
    expect(JSON.stringify(toolEvent)).not.toContain('abcdefghijklmnop');
    expect(errorEvent.message).not.toContain('/home/ec2-user/private');
    expect(errorEvent.message).not.toContain('AWS_SECRET_ACCESS_KEY=secret');
  });

  it('keeps empty tool results as strings', () => {
    const event = sanitizeEvent({
      type: 'assistant',
      provider: 'codex',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: null,
        is_error: false,
      }],
    });

    expect(event.content?.[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: '',
      is_error: false,
    });
  });
});
