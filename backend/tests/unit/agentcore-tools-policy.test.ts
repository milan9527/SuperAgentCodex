import { describe, expect, it } from 'vitest';
import {
  constrainAgentcoreToolList,
  constrainAgentcoreToolRequest,
} from '../../src/services/agentcore-tools-policy.js';

const identifiers = {
  browserIdentifier: 'dedicated-browser',
  codeInterpreterIdentifier: 'dedicated-code-interpreter',
};

describe('AgentCore tools policy', () => {
  it('overrides model-supplied shared identifiers', () => {
    expect(constrainAgentcoreToolRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'start_browser_session',
        arguments: { browser_identifier: 'aws.browser.v1' },
      },
    }, identifiers)).toMatchObject({
      params: {
        arguments: { browser_identifier: 'dedicated-browser' },
      },
    });
  });

  it('constrains advertised identifier schemas', () => {
    expect(constrainAgentcoreToolList({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [{
          name: 'start_browser_session',
          inputSchema: {
            type: 'object',
            properties: { browser_identifier: { type: 'string' } },
          },
        }],
      },
    }, identifiers)).toMatchObject({
      result: {
        tools: [{
          inputSchema: {
            properties: {
              browser_identifier: {
                const: 'dedicated-browser',
                enum: ['dedicated-browser'],
              },
            },
          },
        }],
      },
    });
  });

  it('advertises only Browser and Code Interpreter tools', () => {
    const result = constrainAgentcoreToolList({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'browser_navigate', inputSchema: { type: 'object', properties: {} } },
          { name: 'execute_code', inputSchema: { type: 'object', properties: {} } },
          { name: 'create_agent_runtime', inputSchema: { type: 'object', properties: {} } },
          { name: 'create_gateway', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    }, identifiers) as {
      result: { tools: Array<{ name: string }> };
    };

    expect(result.result.tools.map(tool => tool.name)).toEqual([
      'browser_navigate',
      'execute_code',
    ]);
  });
});
