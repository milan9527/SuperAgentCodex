import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyMCPServerConfig, MCPServerSDKConfig } from './agent-types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const backendRoot = resolve(moduleDir, '..', '..');

export function renderClaudeMcpServers(
  servers: Record<string, AnyMCPServerConfig>,
): Record<string, AnyMCPServerConfig> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      name === 'agentcore-tools' && server.type === 'stdio'
        ? renderAgentcoreToolsServer(server)
        : server,
    ]),
  );
}

function renderAgentcoreToolsServer(server: MCPServerSDKConfig): MCPServerSDKConfig {
  const env = server.env ?? {};
  const browserIdentifier = requireDedicatedIdentifier(
    env.BROWSER_IDENTIFIER ?? process.env.AGENTCORE_BROWSER_IDENTIFIER,
    'BROWSER_IDENTIFIER',
    'aws.browser.v1',
  );
  const codeInterpreterIdentifier = requireDedicatedIdentifier(
    env.CODE_INTERPRETER_IDENTIFIER ?? process.env.AGENTCORE_CODE_INTERPRETER_IDENTIFIER,
    'CODE_INTERPRETER_IDENTIFIER',
    'aws.codeinterpreter.v1',
  );

  return {
    type: 'stdio',
    command: process.execPath,
    args: [join(backendRoot, 'runtime-assets', 'agentcore-tools-proxy.mjs')],
    env: {
      AWS_REGION: env.AWS_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      AWS_DEFAULT_REGION:
        env.AWS_DEFAULT_REGION
        ?? env.AWS_REGION
        ?? process.env.AWS_REGION
        ?? 'us-east-1',
      FASTMCP_LOG_LEVEL: env.FASTMCP_LOG_LEVEL ?? 'ERROR',
      BROWSER_IDENTIFIER: browserIdentifier,
      CODE_INTERPRETER_IDENTIFIER: codeInterpreterIdentifier,
      AGENTCORE_TOOLS_UPSTREAM_COMMAND: 'uvx',
      AGENTCORE_TOOLS_UPSTREAM_ARGS_B64: Buffer.from(JSON.stringify([
        'awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2',
      ])).toString('base64'),
    },
  };
}

function requireDedicatedIdentifier(
  value: string | undefined,
  name: string,
  sharedIdentifier: string,
): string {
  const normalized = value?.trim();
  if (!normalized || normalized === sharedIdentifier) {
    throw new Error(`${name} must reference a dedicated AgentCore resource`);
  }
  return normalized;
}
