import {
  MCP_ENDPOINT_PATH,
  MCP_PROTOCOL_VERSION,
  MCP_STATUS_TOOL_NAME,
} from '@pertexo/contracts';
import { expect } from 'vitest';

interface RpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result: unknown;
}

interface ToolResult {
  isError: boolean;
  structuredContent: {
    status: string;
    invocation?: string;
    result?: unknown;
    code?: string;
  };
}

export function mcpClient(origin: string, workspaceId: string, secret: string) {
  const endpoint = `${origin}${MCP_ENDPOINT_PATH.replace('{workspaceId}', workspaceId)}`;
  const headers = {
    authorization: `Bearer ${secret}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
  };
  let sequence = 0;
  function request(
    method: string,
    params?: unknown,
    overrides?: Record<string, string>,
    notification = false,
  ) {
    sequence += 1;
    return fetch(endpoint, {
      method: 'POST',
      headers: { ...headers, ...overrides },
      body: JSON.stringify({
        jsonrpc: '2.0',
        ...(notification ? {} : { id: sequence }),
        method,
        params,
      }),
    });
  }
  async function result(request: Promise<Response>) {
    const response = await request;
    const text = await response.text();
    expect(response.status, text).toBe(200);
    const envelope = JSON.parse(text) as RpcResponse;
    expect(envelope).toHaveProperty('result');
    return envelope.result;
  }
  function call(name: string, args: unknown, key?: string) {
    return request('tools/call', {
      name,
      arguments: args,
      ...(key === undefined
        ? {}
        : { _meta: { 'pertexo/idempotencyKey': key } }),
    });
  }
  async function invoke(name: string, args: unknown, key?: string) {
    return (await result(call(name, args, key))) as ToolResult;
  }
  return {
    endpoint,
    headers,
    request,
    result,
    call,
    invoke,
    list: async () =>
      (await result(request('tools/list'))) as { tools: { name: string }[] },
    status: (invocation: string) =>
      invoke(MCP_STATUS_TOOL_NAME, { invocation }),
  };
}

export function pendingReference(result: ToolResult): string {
  const { invocation } = result.structuredContent;
  if (invocation === undefined)
    throw new Error('MCP response has no invocation reference');
  expect(result.structuredContent.status).toBe('pending');
  return invocation;
}
