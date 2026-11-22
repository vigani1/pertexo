import { HttpStatus } from '@nestjs/common';
import { MCP_ENDPOINT_PATH, MCP_PROTOCOL_VERSION } from '@pertexo/contracts';
import { mcpTransportRoutes } from '@pertexo/contracts/server';
import { STORED_EXECUTION_VALUE_LIMITS } from '@pertexo/node-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rawHeaderValues } from '../platform/http/raw-headers.js';

export const MCP_NEST_PATH = MCP_ENDPOINT_PATH.replace(
  '{workspaceId}',
  ':workspaceId',
);
export const MCP_PROTOCOL_HEADER = 'mcp-protocol-version';
export const MCP_JSON_RPC_VERSION = '2.0';
export const RPC_INVALID_REQUEST = -32600;

// MCP JSON-RPC metadata and envelope fit alongside an inline workflow input.
const MCP_ENVELOPE_BYTES = 4096;
const MCP_BODY_MAX_BYTES =
  STORED_EXECUTION_VALUE_LIMITS.inlineBytes + MCP_ENVELOPE_BYTES;

export function registerMcpTransport(
  instance: FastifyInstance,
  origin: string,
) {
  // Reject invalid transport headers before the bearer guard runs.
  function checkTransport(
    request: FastifyRequest,
    reply: FastifyReply,
    done: () => void,
  ) {
    const headers = request.raw.rawHeaders;
    const origins = rawHeaderValues(headers, 'origin');
    const versions = rawHeaderValues(headers, MCP_PROTOCOL_HEADER);
    if (request.method === 'POST')
      reply.header('Cache-Control', mcpTransportRoutes.exchange.cacheControl);
    if (origins.length > 0 && (origins.length !== 1 || origins[0] !== origin))
      void reply.code(HttpStatus.FORBIDDEN).send();
    else if (
      versions.length > 0 &&
      (versions.length !== 1 || versions[0] !== MCP_PROTOCOL_VERSION)
    )
      void invalidProtocol(reply);
    else done();
  }

  instance.addHook('onRoute', (route) => {
    if (route.url !== MCP_NEST_PATH) return;
    if (route.method === 'POST') route.bodyLimit = MCP_BODY_MAX_BYTES;
    const existing = route.preHandler ?? [];
    route.preHandler = [checkTransport, ...[existing].flat()];
  });
}

export function invalidProtocol(response: FastifyReply) {
  return response
    .code(HttpStatus.BAD_REQUEST)
    .send(
      errorReply(null, RPC_INVALID_REQUEST, 'Unsupported MCP protocol header.'),
    );
}

export function errorReply(
  id: string | number | null,
  code: number,
  message: string,
) {
  return { jsonrpc: MCP_JSON_RPC_VERSION, id, error: { code, message } };
}
