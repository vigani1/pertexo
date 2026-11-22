import {
  MCP_ENDPOINT_PATH,
  MCP_PROTOCOL_VERSION,
} from '../../schemas/workflows/mcp/exposure.js';
import { mcpRpcRequestSchema } from '../../schemas/workflows/mcp/rpc.js';
import {
  jsonRequest,
  jsonSchema,
  pathParameter,
  problemResponse,
} from '../../routes/openapi-primitives.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { workflowSettingsRoutes as settings } from '../../routes/workflows/settings.js';

const routes = [settings.mcp, settings.updateMcp];

export function workflowMcpContractSchemas() {
  return {
    ...routeSchemas(routes),
    McpRpcMessage: jsonSchema(mcpRpcRequestSchema, 'input'),
  };
}

export const workflowMcpContractPaths = routePaths(routes);

export const mcpTransportPaths = {
  [MCP_ENDPOINT_PATH]: {
    post: {
      operationId: 'exchangeMcpMessage',
      description:
        'Stateless Streamable HTTP for a workspace API token. Send the negotiated protocol header after initialize. Calls admit runs and return a status reference. Use params._meta["pertexo/idempotencyKey"] for exact retries while a command receipt is retained.',
      security: [{ apiToken: [] }],
      'x-pertexo-api-token-scopes': ['mcp:invoke'],
      parameters: [
        pathParameter('workspaceId', { type: 'string', format: 'uuid' }),
        {
          in: 'header',
          name: 'MCP-Protocol-Version',
          required: false,
          schema: { type: 'string', const: MCP_PROTOCOL_VERSION },
        },
      ],
      requestBody: jsonRequest('McpRpcMessage'),
      responses: {
        '200': {
          description: 'JSON-RPC request result or protocol error',
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '202': { description: 'Initialized notification accepted' },
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
    },
    get: {
      operationId: 'mcpStandaloneStream',
      description:
        'Standalone server event streams are unavailable in this protocol profile.',
      parameters: [
        pathParameter('workspaceId', { type: 'string', format: 'uuid' }),
      ],
      responses: {
        '405': { description: 'The endpoint accepts POST messages' },
      },
    },
  },
};
