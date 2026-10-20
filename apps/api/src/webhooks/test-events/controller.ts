import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { webhookTestEventStartSchema } from '@pertexo/contracts';
import {
  SessionAuthenticationGuard,
  CsrfProtectionGuard,
  authenticatedSession,
} from '../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WebhookUpdateGuard } from '../guards.js';
import { WebhookTestEventService } from './service.js';
const scope = {
  workspaceId: z.uuid(),
  workflowId: z.uuid(),
  nodeId: z.string().min(1).max(64),
};
const route = z.object(scope).strict();
const sessionRoute = z.object({ ...scope, id: z.uuid() }).strict();
@Controller(
  'v1/workspaces/:workspaceId/workflows/:workflowId/draft/nodes/:nodeId/webhook-test-events',
)
@UseGuards(SessionAuthenticationGuard, WebhookUpdateGuard)
export class WebhookTestEventController {
  constructor(private readonly service: WebhookTestEventService) {}
  @Post()
  @HttpCode(200)
  @RateLimit('trigger_mutation')
  @UseGuards(CsrfProtectionGuard)
  start(
    @Req() request: IdentityWorkspaceRequest & Pick<FastifyRequest, 'raw'>,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    const input = {
      ...route.parse(params),
      ...webhookTestEventStartSchema.parse(body),
      actorId: authenticatedSession(request).userId,
    };
    return withRequestOperationSignal(request, (signal) =>
      this.service.start({ ...input, signal }),
    );
  }
  @Get(':id')
  @RateLimit('authenticated_read')
  get(
    @Req() request: IdentityWorkspaceRequest & Pick<FastifyRequest, 'raw'>,
    @Param() params: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('cache-control', 'no-store');
    return withRequestOperationSignal(request, (signal) =>
      this.service.get({
        ...sessionRoute.parse(params),
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Delete(':id')
  @HttpCode(204)
  @RateLimit('trigger_mutation')
  @UseGuards(CsrfProtectionGuard)
  stop(
    @Req() request: IdentityWorkspaceRequest & Pick<FastifyRequest, 'raw'>,
    @Param() params: unknown,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.stop({
        ...sessionRoute.parse(params),
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
}
