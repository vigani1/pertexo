import { ACTIVE_WORKSPACE_STATUSES } from '@pertexo/policy';
import { MCP_ENDPOINT_PATH } from '../../schemas/workflows/mcp/exposure.js';
import { mcpRpcRequestSchema } from '../../schemas/workflows/mcp/rpc.js';
import { defineRoute, named } from '../define.js';
import { jsonRequest, problemResponse } from '../openapi-primitives.js';
import { workspaceParams } from './access.js';

const message = named('McpRpcMessage', mcpRpcRequestSchema);

export const mcpTransportRoutes = {
  exchange: defineRoute({
    method: 'post',
    path: MCP_ENDPOINT_PATH,
    operationId: 'exchangeMcpMessage',
    description:
      'Stateless Streamable HTTP for a workspace API token. Send the negotiated protocol header after initialize. Calls admit runs and return a status reference. Use params._meta["pertexo/idempotencyKey"] for exact retries while a command receipt is retained.',
    access: {
      auth: 'token',
      capabilities: [
        {
          name: 'mcp:invoke',
          statuses: ACTIVE_WORKSPACE_STATUSES,
          disclosure: 'forbidden',
        },
      ],
    },
    // Authentication and dispatch already admit each request to their limiters.
    rateLimit: 'exempt',
    cacheControl: 'private, no-store',
    params: workspaceParams,
    body: message,
    // The protocol handler supplies JSON-RPC errors for malformed messages.
    requestDocument: jsonRequest(message.name),
    success: {
      status: 200,
      response: {
        description: 'JSON-RPC request result or protocol error',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
    },
    otherSuccesses: [
      {
        status: 202,
        response: { description: 'Initialized notification accepted' },
      },
    ],
    problems: {
      '400': { description: 'Invalid JSON-RPC message or protocol version' },
      '401': { description: 'Workspace bearer token required' },
      '403': { description: 'Origin or token authority refused' },
      '409': problemResponse('The same command key names a different call'),
      '413': problemResponse('The JSON request body exceeded its limit'),
      '429': problemResponse('Request rate limit or run capacity reached'),
      '503': problemResponse(
        'Token authentication or run admission unavailable',
      ),
    },
  }),
  standaloneStream: defineRoute({
    method: 'get',
    path: MCP_ENDPOINT_PATH,
    operationId: 'mcpStandaloneStream',
    description:
      'Standalone server event streams are unavailable in this protocol profile.',
    access: { auth: 'public' },
    rateLimit: 'exempt',
    params: workspaceParams,
    success: {
      status: 405,
      response: { description: 'The endpoint accepts POST messages' },
    },
    problems: {
      '400': { description: 'Invalid MCP protocol version' },
      '403': { description: 'Origin refused' },
    },
  }),
};
