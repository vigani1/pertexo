import {
  MCP_ENDPOINT_PATH,
  MCP_PROTOCOL_VERSION,
} from '../../schemas/workflows/mcp/exposure.js';
import { routePaths, routeSchemas } from '../../routes/openapi.js';
import { mcpTransportRoutes as transport } from '../../routes/workflows/mcp.js';
import { workflowSettingsRoutes as settings } from '../../routes/workflows/settings.js';

const routes = [settings.mcp, settings.updateMcp];
const transportRoutes = [transport.exchange, transport.standaloneStream];

export function workflowMcpContractSchemas() {
  return { ...routeSchemas(routes), ...routeSchemas(transportRoutes) };
}

export const workflowMcpContractPaths = routePaths(routes);

const transportPath = routePaths(transportRoutes)[MCP_ENDPOINT_PATH];
// The handler reads raw header occurrences to preserve JSON-RPC errors for
// duplicate and unsupported protocol headers.
export const mcpTransportPaths = {
  [MCP_ENDPOINT_PATH]: {
    ...transportPath,
    post: {
      ...transportPath.post,
      parameters: [
        ...transportPath.post.parameters,
        {
          in: 'header',
          name: 'MCP-Protocol-Version',
          required: false,
          schema: { type: 'string', const: MCP_PROTOCOL_VERSION },
        },
      ],
    },
  },
};
