type JsonObject = Record<string, unknown>;

export interface AgentcoreToolIdentifiers {
  browserIdentifier: string;
  codeInterpreterIdentifier: string;
}

const BROWSER_SESSION_TOOLS = new Set([
  'start_browser_session',
  'stop_browser_session',
  'get_browser_session',
  'list_browser_sessions',
]);

const CODE_INTERPRETER_TOOLS = new Set([
  'start_code_interpreter_session',
  'stop_code_interpreter_session',
  'get_code_interpreter_session',
  'list_code_interpreter_sessions',
  'execute_code',
  'execute_command',
  'install_packages',
  'upload_file',
  'download_file',
  'list_files',
]);

/** Force platform-managed AgentCore resource identifiers at the MCP boundary. */
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
      tools: message.result.tools
        .filter(isAllowedAgentcoreTool)
        .map(tool => constrainToolSchema(tool, identifiers)),
    },
  };
}

function isAllowedAgentcoreTool(tool: unknown): boolean {
  if (!isObject(tool) || typeof tool.name !== 'string') return false;
  return tool.name.startsWith('browser_')
    || BROWSER_SESSION_TOOLS.has(tool.name)
    || CODE_INTERPRETER_TOOLS.has(tool.name);
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
