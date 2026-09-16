import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { idempotencyKeySchema } from '@pertexo/contracts/identity-workspace';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  readHeader,
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import {
  ConnectionManageGuard,
  ConnectionReadGuard,
  ConnectionUseGuard,
} from './guards.js';
import {
  CreateConnectionUseCase,
  GetConnectionUseCase,
  ListConnectionsUseCase,
  RevokeConnectionUseCase,
  RotateConnectionSecretUseCase,
  TestConnectionUseCase,
} from './use-cases.js';
import {
  connectionIdParamSchema,
  connectionListQuerySchema,
  connectionWorkspaceParamSchema,
  type ConnectionRequest,
} from './types.js';

@Controller('v1/workspaces/:workspaceId/connections')
@RateLimit('connection_mutation')
export class ConnectionsController {
  public constructor(
    private readonly listConnections: ListConnectionsUseCase,
    private readonly getConnection: GetConnectionUseCase,
    private readonly createConnection: CreateConnectionUseCase,
    private readonly rotateSecret: RotateConnectionSecretUseCase,
    private readonly revokeConnection: RevokeConnectionUseCase,
    private readonly testConnection: TestConnectionUseCase,
  ) {}

  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ConnectionReadGuard)
  public list(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workspaceParams(params);
    const input = connectionListQuerySchema.parse(query ?? {});
    const context = projectAuthenticatedWorkspaceContext(request, workspaceId);
    return this.listConnections.execute({
      ...context,
      routeWorkspaceId: workspaceId,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }

  @Get(':connectionId')
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ConnectionReadGuard)
  public read(@Req() request: ConnectionRequest, @Param() params: unknown) {
    const route = connectionIdParamSchema.parse(params);
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    return this.getConnection.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
    });
  }

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
    const context = projectAuthenticatedWorkspaceContext(request, workspaceId);
    return withRequestOperationSignal(request, (signal) =>
      this.createConnection.execute({
        ...context,
        routeWorkspaceId: workspaceId,
        request: body,
        idempotencyKey: idempotencyKey(request),
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
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    return withRequestOperationSignal(request, (signal) =>
      this.rotateSecret.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        connectionId: route.connectionId,
        request: body,
        idempotencyKey: idempotencyKey(request),
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
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    return this.revokeConnection.execute({
      ...context,
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
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
    const context = projectAuthenticatedWorkspaceContext(
      request,
      route.workspaceId,
    );
    return withRequestOperationSignal(request, (signal) =>
      this.testConnection.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        connectionId: route.connectionId,
        request: body,
        idempotencyKey: idempotencyKey(request),
        signal,
      }),
    );
  }
}

function workspaceParams(value: unknown): Readonly<{ workspaceId: string }> {
  return connectionWorkspaceParamSchema.parse(value);
}

function idempotencyKey(request: ConnectionRequest): string {
  return idempotencyKeySchema.parse(readHeader(request, 'idempotency-key'));
}
