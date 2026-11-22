import {
  boundedNodeJsonRecordSchema,
  type SchemaDocument,
} from '@pertexo/node-sdk';
import type { ProviderHttpStreamingBody } from '../providers/http-client.js';
import { MCP_LIMITS } from './mcp-limits.js';
import { McpProtocolError, McpRpcError } from './mcp.errors.js';

export async function readMcpReply(
  response: ProviderHttpStreamingBody,
  id: number,
): Promise<SchemaDocument> {
  const type = response.headers['content-type']
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (type === 'text/event-stream') return readEvents(response.body, id);
  if (type !== 'application/json')
    throw new McpProtocolError('Unexpected MCP reply content type');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  for await (const chunk of response.body)
    text += decoder.decode(chunk, { stream: true });
  const result = readMessage(text + decoder.decode(), id);
  if (result === undefined)
    throw new McpProtocolError('MCP reply has no response');
  return result;
}

const SSE_DATA_FIELD = 'data:';

async function readEvents(body: AsyncIterable<Uint8Array>, id: number) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let data: string[] = [];
  let events = 0;
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let match = /\r\n|\n|\r(?!$)/u.exec(pending);
    while (match !== null) {
      const line = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      if (line.startsWith(SSE_DATA_FIELD))
        data.push(line.slice(SSE_DATA_FIELD.length).replace(/^ /u, ''));
      if (line === '' && data.length > 0) {
        events += 1;
        if (events > MCP_LIMITS.events)
          throw new McpProtocolError('Too many MCP events');
        const message = data.join('\n');
        data = [];
        if (message !== '') {
          const result = readMessage(message, id);
          if (result !== undefined) return result;
        }
      }
      match = /\r\n|\n|\r(?!$)/u.exec(pending);
    }
  }
  decoder.decode();
  throw new McpProtocolError('MCP stream ended before its response');
}

function readMessage(text: string, id: number): SchemaDocument | undefined {
  const candidate = boundedNodeJsonRecordSchema.safeParse(
    JSON.parse(text) as unknown,
  );
  if (!candidate.success || candidate.data.jsonrpc !== '2.0')
    throw new McpProtocolError('Invalid MCP reply');
  const message = candidate.data;
  if (message.id === undefined && typeof message.method === 'string')
    return undefined;
  if (
    message.id !== id ||
    Object.hasOwn(message, 'method') ||
    Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')
  )
    throw new McpProtocolError('Invalid MCP response envelope');
  if (Object.hasOwn(message, 'error')) {
    const error = boundedNodeJsonRecordSchema.safeParse(message.error);
    if (
      !error.success ||
      !Number.isInteger(error.data.code) ||
      typeof error.data.message !== 'string'
    )
      throw new McpProtocolError('Invalid MCP error envelope');
    throw new McpRpcError();
  }
  const result = boundedNodeJsonRecordSchema.safeParse(message.result);
  if (!result.success)
    throw new McpProtocolError('Invalid MCP response result');
  return result.data;
}
