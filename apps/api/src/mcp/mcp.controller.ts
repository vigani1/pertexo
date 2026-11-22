import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  MCP_PROTOCOL_VERSION,
  mcpRpcRequestSchema,
  mcpRpcEnvelopeSchema,
} from '@pertexo/contracts';
import {
  McpToolUnavailableError,
  WorkflowRunNotFoundError,
} from '@pertexo/core/runs';
import { CallableInputInvalidError } from '@pertexo/workflow-model';
import { StoredExecutionValueInvalidError } from '@pertexo/node-sdk';
import { z } from 'zod';
import { ApiTokenAuthentication } from '../authentication/automation/authority.js';
import { RateLimitExempt } from '../platform/rate-limit/metadata.js';
import { rawHeaderValues } from '../platform/http/raw-headers.js';
import {
  requestIdentifier,
  traceIdentifier,
} from '../workspaces/request/identifiers.js';
import { readCookie, SESSION_COOKIE_NAME } from '../workspaces/http/guards.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { McpService, toolResult } from './mcp.service.js';
import { MCP_NEST_PATH } from './transport.js';

const rpc = '2.0';
const workspaceParameter = z.uuid().overwrite((value) => value.toLowerCase());
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;

export class McpOriginPolicy {
  public constructor(public readonly allowedOrigin: string) {}
}

@Controller(MCP_NEST_PATH)
@RateLimitExempt()
export class McpController {
  public constructor(
    private readonly authentication: ApiTokenAuthentication,
    private readonly service: McpService,
    private readonly origin: McpOriginPolicy,
  ) {}

  @Get()
  public get(@Req() request: FastifyRequest, @Res() response: FastifyReply) {
    if (!this.validOrigin(request))
      return response.code(HttpStatus.FORBIDDEN).send();
    if (protocolHeader(request) === 'invalid') return invalidProtocol(response);
    return response
      .header('Allow', 'POST')
      .code(HttpStatus.METHOD_NOT_ALLOWED)
      .send();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  public async post(
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest & IdentityWorkspaceRequest,
    @Res() response: FastifyReply,
  ) {
    response.header('Cache-Control', 'private, no-store');
    if (!this.validOrigin(request))
      return response.code(HttpStatus.FORBIDDEN).send();
    const protocol = protocolHeader(request);
    if (protocol === 'invalid') return invalidProtocol(response);
    const token = await this.authentication.authenticate({
      headers: request.headers,
      rawHeaders: request.raw.rawHeaders,
      clientAddress: request.ip,
      hasSession: readCookie(request, SESSION_COOKIE_NAME) !== undefined,
    });
    if (token === undefined)
      return response
        .header('WWW-Authenticate', 'Bearer realm="pertexo"')
        .code(HttpStatus.UNAUTHORIZED)
        .send();
    const workspace = workspaceParameter.safeParse(workspaceId);
    if (
      !workspace.success ||
      token.workspaceId !== workspace.data ||
      !token.scopes.includes('mcp:invoke')
    )
      return response.code(HttpStatus.FORBIDDEN).send();

    const parsed = mcpRpcRequestSchema.safeParse(body);
    if (!parsed.success) return invalidMessage(response, body);
    const input = parsed.data;
    if (protocol === 'missing' && input.method !== 'initialize')
      return invalidProtocol(response);
    if (input.method === 'notifications/initialized')
      return response.code(HttpStatus.ACCEPTED).send();
    const traceId = traceIdentifier(request);
    const actor = {
      actorId: token.ownerUserId,
      workspaceId: workspace.data,
      tokenId: token.tokenId,
      requestId: requestIdentifier(request),
      ...(traceId === undefined ? {} : { traceId }),
    };
    try {
      const result = await this.service.dispatch(input, actor);
      return await response.send({ jsonrpc: rpc, id: input.id, result });
    } catch (error) {
      const failure = toolFailure(error);
      if (input.method === 'tools/call' && failure !== undefined)
        return response.send({
          jsonrpc: rpc,
          id: input.id,
          result: toolResult(failure),
        });
      throw error;
    }
  }

  private validOrigin(request: FastifyRequest) {
    const values = rawHeaderValues(request.raw.rawHeaders, 'origin');
    return (
      values.length === 0 ||
      (values.length === 1 && values[0] === this.origin.allowedOrigin)
    );
  }
}

function protocolHeader(request: FastifyRequest) {
  const values = rawHeaderValues(
    request.raw.rawHeaders,
    'mcp-protocol-version',
  );
  if (values.length === 0) return 'missing';
  return values.length === 1 && values[0] === MCP_PROTOCOL_VERSION
    ? 'supported'
    : 'invalid';
}

function invalidProtocol(response: FastifyReply) {
  return response
    .code(HttpStatus.BAD_REQUEST)
    .send(
      errorReply(null, RPC_INVALID_REQUEST, 'Unsupported MCP protocol header.'),
    );
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

function errorReply(id: string | number | null, code: number, message: string) {
  return { jsonrpc: rpc, id, error: { code, message } };
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
