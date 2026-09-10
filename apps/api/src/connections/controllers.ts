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
  readHeader,
} from '../identity-workspace/index.js';
import {
  authenticatedRequestIdentifiers,
  optionalAuthorizedWorkspace,
  projectAuthenticatedWorkspaceContext,
} from '../identity-workspace/authenticated-command-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import { ConnectionManageGuard, ConnectionUseGuard } from './guards.js';
import {
  CreateConnectionUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from './use-cases.js';
import {
  connectionIdParamSchema,
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
    const { workspaceId } = workspaceParams(params);
    return withRequestOperationSignal(request, (signal) =>
      this.createConnection.execute({
        actor: actorFrom(request, workspaceId),
        routeWorkspaceId: workspaceId,
        ...guardAuthorization(request),
        request: body,
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
        signal,
      }),
    );
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
    const route = connectionIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.rotateSecret.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        connectionId: route.connectionId,
        request: body,
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
        signal,
      }),
    );
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
    const route = connectionIdParamSchema.parse(params);
    return this.revokeConnection.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...guardAuthorization(request),
      connectionId: route.connectionId,
      ...requestMetadata(request),
    });
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
    const route = connectionIdParamSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.testConnection.execute({
        actor: actorFrom(request, route.workspaceId),
        routeWorkspaceId: route.workspaceId,
        ...guardAuthorization(request),
        connectionId: route.connectionId,
        request: body,
        idempotencyKey: idempotencyKey(request),
        ...requestMetadata(request),
        signal,
      }),
    );
  }
}

function guardAuthorization(
  request: ConnectionRequest,
): Pick<ConnectionRequest, 'authorizedWorkspace'> {
  return optionalAuthorizedWorkspace(request);
}

function workspaceParams(value: unknown): Readonly<{ workspaceId: string }> {
  return connectionWorkspaceParamSchema.parse(value);
}

function actorFrom(request: ConnectionRequest, workspaceId: string) {
  return projectAuthenticatedWorkspaceContext(request, workspaceId).actor;
}

function idempotencyKey(request: ConnectionRequest): string {
  return idempotencyKeySchema.parse(readHeader(request, 'idempotency-key'));
}

function requestMetadata(request: ConnectionRequest): Readonly<{
  requestId: string;
  traceId?: string;
}> {
  return authenticatedRequestIdentifiers(request);
}
