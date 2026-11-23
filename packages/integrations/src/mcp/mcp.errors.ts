export class McpProtocolError extends Error {
  public override readonly name = 'McpProtocolError';
}

export class McpRpcError extends Error {
  public override readonly name = 'McpRpcError';

  public constructor() {
    super('MCP endpoint reported an operation failure');
  }
}
