import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
  readHeader,
  requestIdentifier,
  traceIdentifier,
} from '../identity-workspace/index.js';
import { createActorContext } from '../workspaces/index.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { throwConnectionApplicationError } from './errors.js';
import { ConnectionManageGuard, ConnectionUseGuard } from './guards.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from './use-cases.js';
import {
  connectionCreateRequestSchema,
  connectionIdParamSchema,
  connectionRotateSecretRequestSchema,
  connectionTestRequestSchema,
  connectionWorkspaceParamSchema,
  type ConnectionRequest,
} from './types.js';

@Controller('v1/workspaces/:workspaceId/connections')
@RateLimit('connection_mutation')
export class ConnectionsController {
  public constructor(
    private readonly createConnection: CreateConnectionUseCase,
    private readonly rotateSecret: RotateConnectionSecretUseCase,
    private readonly revokeConnection: RevokeConnectionUseCase,
    private readonly testConnection: TestConnectionUseCase,
  ) {}

  @Post()
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async create(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId } = workspaceParams(params);
      return await this.createConnection.execute({
        actor: actorFrom(request, workspaceId),
        routeWorkspaceId: workspaceId,
        request: connectionCreateRequestSchema.parse(body),
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
      });
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }

  @Put(':connectionId/secret')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async rotate(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = connectionIdParamSchema.parse(params);
      return await this.rotateSecret.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        connectionId: route.connectionId,
        request: connectionRotateSecretRequestSchema.parse(body),
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
      });
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }

  @Delete(':connectionId')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  public async revoke(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
  ) {
    try {
      const route = connectionIdParamSchema.parse(params);
      return await this.revokeConnection.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        connectionId: route.connectionId,
        ...requestMetadata(request),
      });
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }

  @Post(':connectionId/test')
  @RateLimit('provider_test')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionUseGuard,
    CsrfProtectionGuard,
  )
  public async test(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const route = connectionIdParamSchema.parse(params);
      return await this.testConnection.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        connectionId: route.connectionId,
        request: connectionTestRequestSchema.parse(body),
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
      });
    } catch (error: unknown) {
      return throwConnectionApplicationError(error);
    }
  }
}

function workspaceParams(value: unknown): Readonly<{ workspaceId: string }> {
  return connectionWorkspaceParamSchema.parse(value);
}

function actorFrom(request: ConnectionRequest, workspaceId: string) {
  const session = authenticatedSession(request);
  const traceId = traceIdentifier(request);
  return createActorContext({
    actorId: session.userId,
    workspaceId,
    sessionId: session.sessionId,
    requestId: requestIdentifier(request),
    ...(traceId === undefined ? {} : { traceId }),
  });
}

function idempotencyKey(request: ConnectionRequest): string {
  return idempotencyKeySchema.parse(readHeader(request, 'idempotency-key'));
}

function requestMetadata(request: ConnectionRequest): Readonly<{
  requestId: string;
  traceId?: string;
}> {
  const traceId = traceIdentifier(request);
  return {
    requestId: requestIdentifier(request),
    ...(traceId === undefined ? {} : { traceId }),
  };
}
