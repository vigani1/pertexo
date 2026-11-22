import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';

export const MCP_TOKEN = 'synthetic-mcp-credential';
export const TOOL_INPUT = {
  type: 'object',
  properties: { count: { type: 'integer' } },
  required: ['count'],
  additionalProperties: false,
};

type Request = Readonly<{
  id: number;
  method: string;
  params: unknown;
}>;

export type Answer = (response: ServerResponse, request: Request) => void;

export function reply(
  response: ServerResponse,
  request: Request,
  result: unknown,
) {
  response
    .writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}

export async function fakeMcp(
  overrides: Readonly<Record<string, Answer>> = {},
) {
  const calls: {
    path: string | undefined;
    method: string;
    session: string | undefined;
    params: unknown;
  }[] = [];
  const session = 'fake-session';
  const endpointPath = '/provider/mcp';
  const server = createServer((request, response) => {
    if (
      request.url !== endpointPath ||
      request.headers.authorization !== `Bearer ${MCP_TOKEN}`
    ) {
      response.writeHead(401).end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      const rpc = JSON.parse(body) as Request;
      const sessionHeader = request.headers['mcp-session-id'];
      calls.push({
        path: request.url,
        method: rpc.method,
        session: typeof sessionHeader === 'string' ? sessionHeader : undefined,
        params: rpc.params,
      });
      if (
        rpc.method !== 'initialize' &&
        (sessionHeader !== session ||
          request.headers['mcp-protocol-version'] !== '2025-11-25')
      ) {
        response.writeHead(400).end();
        return;
      }
      const override = overrides[rpc.method];
      if (override !== undefined) {
        override(response, rpc);
        return;
      }
      switch (rpc.method) {
        case 'initialize':
          response
            .writeHead(200, {
              'content-type': 'application/json',
              'mcp-session-id': session,
            })
            .end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'Fixture', version: '1' },
                },
              }),
            );
          return;
        case 'notifications/initialized':
          response.writeHead(202).end();
          return;
        case 'tools/list':
          reply(response, rpc, {
            tools: [
              {
                name: 'counter',
                title: 'Counter',
                inputSchema: TOOL_INPUT,
                outputSchema: TOOL_INPUT,
              },
            ],
          });
          return;
        case 'tools/call':
          response
            .writeHead(200, { 'content-type': 'text/event-stream' })
            .end(
              `id: first\r\ndata:\r\n\r\n: keepalive\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [], structuredContent: { count: (rpc.params as { arguments: { count: number } }).arguments.count } } })}\r\n\r\n`,
            );
          return;
        default:
          response.writeHead(404).end();
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('MCP test server has no TCP address');
  return {
    calls,
    url: `http://127.0.0.1:${String(address.port)}${endpointPath}`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        }),
      );
    },
  };
}
