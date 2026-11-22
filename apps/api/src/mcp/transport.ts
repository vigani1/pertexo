import { MCP_ENDPOINT_PATH } from '@pertexo/contracts';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import type { FastifyInstance } from 'fastify';

export const MCP_NEST_PATH = MCP_ENDPOINT_PATH.replace(
  '{workspaceId}',
  ':workspaceId',
);

// MCP JSON-RPC metadata and envelope fit alongside an inline workflow input.
const MCP_ENVELOPE_BYTES = 4096;
const MCP_BODY_MAX_BYTES =
  STORED_EXECUTION_VALUE_LIMITS.inlineBytes + MCP_ENVELOPE_BYTES;

export function registerMcpTransport(instance: FastifyInstance) {
  instance.addHook('onRoute', (route) => {
    if (route.url === MCP_NEST_PATH && route.method === 'POST')
      route.bodyLimit = MCP_BODY_MAX_BYTES;
  });
}
