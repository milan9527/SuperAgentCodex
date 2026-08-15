import { describe, expect, it } from 'vitest';
import { renderClaudeMcpServers } from '../../src/services/claude-mcp-servers.js';

describe('renderClaudeMcpServers', () => {
  it('rewrites AgentCore tools through the dedicated backend proxy', () => {
    const rendered = renderClaudeMcpServers({
      'agentcore-tools': {
        type: 'stdio',
        command: 'uvx',
        args: ['awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2'],
        env: {
          AWS_REGION: 'us-east-1',
          BROWSER_IDENTIFIER: 'dedicated-browser',
          CODE_INTERPRETER_IDENTIFIER: 'dedicated-code-interpreter',
        },
      },
    });

    const server = rendered['agentcore-tools'];
    expect(server?.type).toBe('stdio');
    if (!server || server.type !== 'stdio') throw new Error('Expected stdio MCP server');
    expect(server.command).toBe(process.execPath);
    expect(server.args?.[0]).toMatch(/runtime-assets\/agentcore-tools-proxy\.mjs$/);
    expect(server.env?.BROWSER_IDENTIFIER).toBe('dedicated-browser');
    expect(server.env?.CODE_INTERPRETER_IDENTIFIER).toBe('dedicated-code-interpreter');
    expect(server.env?.AGENTCORE_TOOLS_UPSTREAM_COMMAND).toBe('uvx');
  });

  it('rejects shared AgentCore tool identifiers', () => {
    expect(() => renderClaudeMcpServers({
      'agentcore-tools': {
        type: 'stdio',
        command: 'uvx',
        env: {
          BROWSER_IDENTIFIER: 'aws.browser.v1',
          CODE_INTERPRETER_IDENTIFIER: 'dedicated-code-interpreter',
        },
      },
    })).toThrow('BROWSER_IDENTIFIER must reference a dedicated AgentCore resource');
  });
});
