import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { connectionIdParamSchema } from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { requestIdempotencyKey } from '../../platform/http/index.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { ConnectionManageGuard } from '../http/guards.js';
import type { ConnectionRequest } from '../types.js';
import { ConnectionSharingUseCases } from './use-case.js';

@Controller('v1/workspaces/:workspaceId/connections/:connectionId/sharing')
@RateLimit('connection_mutation')
export class ConnectionSharingController {
  constructor(private readonly sharing: ConnectionSharingUseCases) {}
  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, ConnectionManageGuard)
  read(@Req() request: ConnectionRequest, @Param() params: unknown) {
    const route = connectionIdParamSchema.parse(params);
    return this.sharing.read({
      ...projectAuthenticatedWorkspaceContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
    });
  }
  @Post()
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    ConnectionManageGuard,
    CsrfProtectionGuard,
  )
  replace(
    @Req() request: ConnectionRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = connectionIdParamSchema.parse(params);
    return this.sharing.replace({
      ...projectAuthenticatedWorkspaceContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      connectionId: route.connectionId,
      request: body,
      idempotencyKey: requestIdempotencyKey(request.headers),
    });
  }
}
