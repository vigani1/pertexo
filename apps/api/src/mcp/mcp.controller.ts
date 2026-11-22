import { Body, Controller, HttpStatus, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { mcpRpcRequestSchema, mcpRpcEnvelopeSchema } from '@pertexo/contracts';
import { mcpTransportRoutes as routes } from '@pertexo/contracts/server';
import {
  McpToolUnavailableError,
  WorkflowRunNotFoundError,
} from '@pertexo/core/runs';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';
import { Route } from '../platform/http/route.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import {
  Caller,
  requestIdentifiers,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';
import { McpService, toolResult } from './mcp.service.js';
import {
  MCP_JSON_RPC_VERSION,
  MCP_PROTOCOL_HEADER,
  RPC_INVALID_REQUEST,
  errorReply,
  invalidProtocol,
} from './transport.js';
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

@Controller()
export class McpController {
  public constructor(private readonly service: McpService) {}

  @Route(routes.standaloneStream)
  public get(@Res() response: FastifyReply) {
    return response.header('Allow', 'POST').send();
  }

  @Route(routes.exchange)
  public async post(
    @Caller() caller: WorkspaceCaller,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res() response: FastifyReply,
  ) {
    const parsed = mcpRpcRequestSchema.safeParse(body);
    if (!parsed.success) return invalidMessage(response, body);
    const input = parsed.data;
    if (
      request.headers[MCP_PROTOCOL_HEADER] === undefined &&
      input.method !== 'initialize'
    )
      return invalidProtocol(response);
    if (input.method === 'notifications/initialized')
      return response.code(HttpStatus.ACCEPTED).send();
    const { actor, workspaceId } = caller;
    if (actor.kind !== 'api_key')
      return throwApplicationError(applicationError('auth.unauthenticated'));
    try {
      const result = await this.service.dispatch(input, {
        actorId: actor.actorId,
        workspaceId,
        tokenId: actor.tokenId,
        ...requestIdentifiers(caller),
      });
      return await response.send({
        jsonrpc: MCP_JSON_RPC_VERSION,
        id: input.id,
        result,
      });
    } catch (error) {
      const failure = toolFailure(error);
      if (input.method === 'tools/call' && failure !== undefined)
        return response.send({
          jsonrpc: MCP_JSON_RPC_VERSION,
          id: input.id,
          result: toolResult(failure),
        });
      throw error;
    }
  }
}

function invalidMessage(response: FastifyReply, body: unknown) {
  const envelope = mcpRpcEnvelopeSchema.safeParse(body);
  if (!envelope.success)
    return response
      .code(HttpStatus.BAD_REQUEST)
      .send(errorReply(null, RPC_INVALID_REQUEST, 'Invalid request.'));
  const { id, method } = envelope.data;
  const known = mcpRpcRequestSchema.options.some(
    ({ shape }) => shape.method.value === method,
  );
  return response
    .code(id === undefined ? HttpStatus.BAD_REQUEST : HttpStatus.OK)
    .send(
      errorReply(
        id ?? null,
        known ? RPC_INVALID_PARAMS : RPC_METHOD_NOT_FOUND,
        known ? 'Invalid parameters.' : 'Method not found.',
      ),
    );
}

function toolFailure(error: unknown) {
  if (
    error instanceof McpToolUnavailableError ||
    error instanceof WorkflowRunNotFoundError
  )
    return { status: 'failed', code: 'unavailable' };
  if (
    error instanceof CallableInputInvalidError ||
    error instanceof StoredExecutionValueInvalidError
  )
    return { status: 'failed', code: 'invalid_input' };
  return undefined;
}
