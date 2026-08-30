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
import { webhookRotateSecretRequestSchema } from '@pertexo/contracts';
import { z } from 'zod';

import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../identity-workspace/index.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { parseIdempotencyKey } from '../workflow-authoring/preconditions.js';
import { WebhookReadGuard, WebhookUpdateGuard } from './guards.js';
import { WebhookManagementService } from './service.js';

const routeSchema = z.object({ workspaceId: z.uuid(), workflowId: z.uuid() });
const commandRouteSchema = routeSchema.extend({ triggerId: z.uuid() });
type Request = IdentityWorkspaceRequest;

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/triggers')
@RateLimit('trigger_mutation')
export class WebhookManagementController {
  public constructor(private readonly service: WebhookManagementService) {}

  @Get()
  @RateLimit('authenticated_read')
  @UseGuards(SessionAuthenticationGuard, WebhookReadGuard)
  public list(@Req() request: Request, @Param() params: unknown) {
    const route = routeSchema.parse(params);
    return this.service.list({
      workspaceId: route.workspaceId,
      workflowId: route.workflowId,
      actorId: authenticatedSession(request).userId,
    });
  }

  @Post(':triggerId/webhook/provision')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WebhookUpdateGuard,
    CsrfProtectionGuard,
  )
  public provision(@Req() request: Request, @Param() params: unknown) {
    return this.command('provision', request, params);
  }

  @Post(':triggerId/webhook/rotate-endpoint')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WebhookUpdateGuard,
    CsrfProtectionGuard,
  )
  public rotateEndpoint(@Req() request: Request, @Param() params: unknown) {
    return this.command('rotateEndpoint', request, params);
  }

  @Post(':triggerId/webhook/rotate-secret')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WebhookUpdateGuard,
    CsrfProtectionGuard,
  )
  public rotateSecret(
    @Req() request: Request,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const input = webhookRotateSecretRequestSchema.parse(body);
    return this.command('rotateSecret', request, params, input.endpointKey);
  }

  private command(
    operation: Operation,
    request: Request,
    params: unknown,
    endpointKey?: string,
  ) {
    const route = commandRouteSchema.parse(params);
    return this.service[operation]({
      workspaceId: route.workspaceId,
      triggerId: route.triggerId,
      actorId: authenticatedSession(request).userId,
      idempotencyKey: parseIdempotencyKey(request.headers?.['idempotency-key']),
      ...(endpointKey === undefined ? {} : { endpointKey }),
    });
  }
}

type Operation = 'provision' | 'rotateEndpoint' | 'rotateSecret';
