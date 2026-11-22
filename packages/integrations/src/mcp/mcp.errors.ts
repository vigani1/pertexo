export class McpProtocolError extends Error {
  public override readonly name = 'McpProtocolError';
}

export class McpHttpError extends Error {
  public override readonly name = 'McpHttpError';

  public constructor(public readonly status: number) {
    super('MCP endpoint refused the exchange');
  }
}

export class McpRpcError extends Error {
  public override readonly name = 'McpRpcError';

  public constructor() {
    super('MCP endpoint reported an operation failure');
  }
}
