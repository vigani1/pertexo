import type { SchemaDocument } from '@pertexo/node-sdk';
import { isRecord } from '@pertexo/workflow-model';
import type { ProviderHttpClient } from '../providers/http-client.js';
import type { McpCredential } from './connections.definition.js';
import { MCP_LIMITS, MCP_PROTOCOL_VERSION } from './mcp-limits.js';
import { McpHttpError, McpProtocolError } from './mcp.errors.js';
import { readMcpReply } from './reply.js';

export type McpHttp = Pick<ProviderHttpClient, 'executeStreaming'>;

export async function openMcpSession(
  credential: McpCredential,
  {
    http,
    signal,
    beforeDispatch,
  }: Readonly<{
    http: McpHttp;
    signal: AbortSignal;
    beforeDispatch(): Promise<void>;
  }>,
) {
  let sequence = 0;
  async function exchange(
    method: string,
    params: SchemaDocument,
    fence: () => Promise<void>,
    {
      notification,
      sessionId,
    }: Readonly<{ notification?: true; sessionId?: string | undefined }> = {},
  ) {
    signal.throwIfAborted();
    const id = sequence++;
    const body = new TextEncoder().encode(
      JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        ...(notification ? {} : { id }),
      }),
    );
    try {
      if (body.byteLength > MCP_LIMITS.requestBytes)
        throw new McpProtocolError('MCP request exceeded its byte limit');
      return await http.executeStreaming(
        {
          url: credential.endpoint,
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential.token}`,
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            ...(method === 'initialize'
              ? {}
              : { 'mcp-protocol-version': MCP_PROTOCOL_VERSION }),
            ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
          },
          body,
          signal,
          timeoutMillis: MCP_LIMITS.timeoutMillis,
          maxRedirects: 0,
          maxResponseBytes: MCP_LIMITS.responseBytes,
          sensitiveValues: [
            credential.token,
            ...(sessionId === undefined ? [] : [sessionId]),
          ],
          rejectSensitiveResponse: true,
          ...(method === 'initialize'
            ? ({ privateResponseHeader: 'mcp-session-id' } as const)
            : {}),
          beforeDispatch: fence,
        },
        async (response) => {
          if (response.status < 200 || response.status >= 300)
            throw new McpHttpError(response.status);
          if (!notification) {
            return {
              result: await readMcpReply(response, id),
              sessionId: response.privateHeader,
            };
          }
          if (response.status !== 202)
            throw new McpProtocolError('MCP notification was not accepted');
          return undefined;
        },
      );
    } finally {
      body.fill(0);
    }
  }
  const initialized = await exchange(
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Pertexo', version: '1' },
    },
    beforeDispatch,
  );
  const result = initialized.body?.result;
  if (
    result?.protocolVersion !== MCP_PROTOCOL_VERSION ||
    !isRecord(result.capabilities) ||
    !isRecord(result.capabilities.tools)
  )
    throw new McpProtocolError(
      'MCP endpoint does not support the tool protocol',
    );
  const sessionId = initialized.body?.sessionId;
  if (
    sessionId !== undefined &&
    (sessionId.length > MCP_LIMITS.sessionCharacters ||
      !/^[!-~]+$/u.test(sessionId) ||
      sessionId.includes(credential.token))
  )
    throw new McpProtocolError('Invalid MCP session identifier');

  await exchange('notifications/initialized', {}, beforeDispatch, {
    notification: true,
    sessionId,
  });

  return async (
    method: 'tools/list' | 'tools/call',
    params: SchemaDocument,
    fence = beforeDispatch,
  ) => {
    const response = await exchange(method, params, fence, { sessionId });
    if (response.body === undefined)
      throw new McpProtocolError('MCP response missing');
    return response.body.result;
  };
}
