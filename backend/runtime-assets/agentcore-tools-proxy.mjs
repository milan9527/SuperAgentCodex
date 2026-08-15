import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  constrainAgentcoreToolList,
  constrainAgentcoreToolRequest,
} from '../dist/services/agentcore-tools-policy.js';

const browserIdentifier = requiredDedicatedIdentifier(
  'BROWSER_IDENTIFIER',
  'aws.browser.v1',
);
const codeInterpreterIdentifier = requiredDedicatedIdentifier(
  'CODE_INTERPRETER_IDENTIFIER',
  'aws.codeinterpreter.v1',
);
const command = process.env.AGENTCORE_TOOLS_UPSTREAM_COMMAND || 'uvx';
const args = decodeArgs(process.env.AGENTCORE_TOOLS_UPSTREAM_ARGS_B64);
const identifiers = { browserIdentifier, codeInterpreterIdentifier };

const child = spawn(command, args, {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

const clientLines = createInterface({ input: process.stdin, crlfDelay: Infinity });
clientLines.on('line', line => {
  child.stdin.write(`${transformLine(line, message =>
    constrainAgentcoreToolRequest(message, identifiers))}\n`);
});
clientLines.on('close', () => child.stdin.end());

const serverLines = createInterface({ input: child.stdout, crlfDelay: Infinity });
serverLines.on('line', line => {
  process.stdout.write(`${transformLine(line, message =>
    constrainAgentcoreToolList(message, identifiers))}\n`);
});

child.stderr.pipe(process.stderr);
child.on('error', error => {
  console.error(`[agentcore-tools-proxy] Failed to start upstream MCP server: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[agentcore-tools-proxy] Upstream exited from signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

function transformLine(line, transform) {
  try {
    return JSON.stringify(transform(JSON.parse(line)));
  } catch {
    return line;
  }
}

function requiredDedicatedIdentifier(name, sharedIdentifier) {
  const value = process.env[name]?.trim();
  if (!value || value === sharedIdentifier) {
    throw new Error(`${name} must reference a dedicated AgentCore resource`);
  }
  return value;
}

function decodeArgs(encoded) {
  if (!encoded) {
    return ['awslabs.amazon-bedrock-agentcore-mcp-server@0.1.2'];
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8'));
  if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string')) {
    throw new Error('AGENTCORE_TOOLS_UPSTREAM_ARGS_B64 must encode a string array');
  }
  return parsed;
}
