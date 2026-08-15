type JsonObject = Record<string, unknown>;

export interface AgentcoreToolIdentifiers {
  browserIdentifier: string;
  codeInterpreterIdentifier: string;
}

/**
 * Force platform-managed AgentCore resources at the MCP boundary. Environment
 * defaults alone are insufficient because a model can explicitly pass the
 * shared aws.browser.v1/aws.codeinterpreter.v1 identifiers.
 */
export function constrainAgentcoreToolRequest(
  message: unknown,
  identifiers: AgentcoreToolIdentifiers,
): unknown {
  if (!isObject(message) || message.method !== 'tools/call' || !isObject(message.params)) {
    return message;
  }
  const toolName = typeof message.params.name === 'string' ? message.params.name : '';
  const originalArguments = isObject(message.params.arguments)
    ? message.params.arguments
    : {};
  const args = { ...originalArguments };

  if ('browser_identifier' in args || toolName === 'start_browser_session') {
    args.browser_identifier = identifiers.browserIdentifier;
  }
  if (
    'code_interpreter_identifier' in args
    || toolName === 'start_code_interpreter_session'
  ) {
    args.code_interpreter_identifier = identifiers.codeInterpreterIdentifier;
  }

  return {
    ...message,
    params: {
      ...message.params,
      arguments: args,
    },
  };
}

export function constrainAgentcoreToolList(
  message: unknown,
  identifiers: AgentcoreToolIdentifiers,
): unknown {
  if (!isObject(message) || !isObject(message.result) || !Array.isArray(message.result.tools)) {
    return message;
  }
  return {
    ...message,
    result: {
      ...message.result,
      tools: message.result.tools.map(tool => constrainToolSchema(tool, identifiers)),
    },
  };
}

function constrainToolSchema(
  tool: unknown,
  identifiers: AgentcoreToolIdentifiers,
): unknown {
  if (!isObject(tool) || !isObject(tool.inputSchema) || !isObject(tool.inputSchema.properties)) {
    return tool;
  }
  const properties = { ...tool.inputSchema.properties };
  if (isObject(properties.browser_identifier)) {
    properties.browser_identifier = constrainIdentifierSchema(
      properties.browser_identifier,
      identifiers.browserIdentifier,
    );
  }
  if (isObject(properties.code_interpreter_identifier)) {
    properties.code_interpreter_identifier = constrainIdentifierSchema(
      properties.code_interpreter_identifier,
      identifiers.codeInterpreterIdentifier,
    );
  }
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties,
    },
  };
}

function constrainIdentifierSchema(schema: JsonObject, identifier: string): JsonObject {
  return {
    ...schema,
    const: identifier,
    enum: [identifier],
    default: identifier,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
