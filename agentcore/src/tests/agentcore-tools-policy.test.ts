import assert from 'node:assert/strict';
import test from 'node:test';
import {
  constrainAgentcoreToolList,
  constrainAgentcoreToolRequest,
} from '../agentcore-tools-policy.js';

const identifiers = {
  browserIdentifier: 'SuperAgentCodex_browser_webauth-fE2H1Jk9Cb',
  codeInterpreterIdentifier: 'SuperAgentCodex_code_interpreter-H5bXUddPM2',
};

test('overrides a model-supplied shared browser identifier', () => {
  const result = constrainAgentcoreToolRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'start_browser_session',
      arguments: {
        browser_identifier: 'aws.browser.v1',
        region: 'us-east-1',
      },
    },
  }, identifiers) as {
    params: { arguments: Record<string, unknown> };
  };

  assert.equal(
    result.params.arguments.browser_identifier,
    identifiers.browserIdentifier,
  );
  assert.equal(result.params.arguments.region, 'us-east-1');
});

test('overrides a model-supplied shared code interpreter identifier', () => {
  const result = constrainAgentcoreToolRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'start_code_interpreter_session',
      arguments: {
        code_interpreter_identifier: 'aws.codeinterpreter.v1',
      },
    },
  }, identifiers) as {
    params: { arguments: Record<string, unknown> };
  };

  assert.equal(
    result.params.arguments.code_interpreter_identifier,
    identifiers.codeInterpreterIdentifier,
  );
});

test('narrows identifier schemas in tools/list responses', () => {
  const result = constrainAgentcoreToolList({
    jsonrpc: '2.0',
    id: 3,
    result: {
      tools: [{
        name: 'start_browser_session',
        inputSchema: {
          type: 'object',
          properties: {
            browser_identifier: { type: 'string' },
          },
        },
      }],
    },
  }, identifiers) as {
    result: {
      tools: Array<{
        inputSchema: {
          properties: {
            browser_identifier: Record<string, unknown>;
          };
        };
      }>;
    };
  };

  assert.deepEqual(
    result.result.tools[0]?.inputSchema.properties.browser_identifier,
    {
      type: 'string',
      const: identifiers.browserIdentifier,
      enum: [identifiers.browserIdentifier],
      default: identifiers.browserIdentifier,
    },
  );
});

test('leaves unrelated MCP calls unchanged', () => {
  const request = {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'browser_navigate',
      arguments: { session_id: 'session-1', url: 'https://example.com' },
    },
  };

  assert.deepEqual(
    constrainAgentcoreToolRequest(request, identifiers),
    request,
  );
});
