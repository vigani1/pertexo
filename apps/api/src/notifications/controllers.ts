import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  workspaceInboxListQuerySchema,
  workspaceInboxReadAllRequestSchema,
  workspaceInboxReadRequestSchema,
  workspaceInboxThreadParamsSchema,
} from '@pertexo/contracts';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';

import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../identity-workspace/index.js';
import type { WorkspaceAuthorizationSource } from '../identity-workspace/ports.js';
import type { IdentityWorkspaceRequest } from '../identity-workspace/types.js';
import { ApiDrainState } from '../platform/health/drain-state.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { prepareSseResponse } from '../platform/http/sse-response.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { createStreamAuthorizationLifetime } from '../workflow-runs/sse-authorization-lifetime.js';
import { mapNotificationError } from './errors.js';
import { NotificationReadGuard } from './guards.js';
import { writeInboxHintStream } from './hint-stream.js';
import type {
  InboxHintSource,
  InboxHintSubscription,
} from './inbox-hint-hub.js';
import { WorkspaceInboxService } from './service.js';
import { INBOX_HINT_SOURCE, NOTIFICATION_AUTHORIZATION } from './tokens.js';

const workspaceRouteSchema = z
  .object({ workspaceId: z.uuid() })
  .strict()
  .readonly();

/** Maximum time an open stream may rely on a previously verified access fact. */
const STREAM_REAUTHORIZATION_INTERVAL_MS = 5_000;

type NotificationsRequest = IdentityWorkspaceRequest &
  Readonly<{
    raw?: Readonly<{
      once(event: 'close', listener: () => void): unknown;
      off(event: 'close', listener: () => void): unknown;
    }>;
  }>;

/** ADR 055: a reader's failure threads, private read state and live hints. */
@Controller('v1/workspaces/:workspaceId/notifications')
@RateLimit('authenticated_read')
export class NotificationsController {
  public constructor(
    private readonly service: WorkspaceInboxService,
    @Inject(INBOX_HINT_SOURCE) private readonly hints: InboxHintSource,
    @Inject(NOTIFICATION_AUTHORIZATION)
    private readonly authorization: WorkspaceAuthorizationSource,
    @Optional()
    private readonly drainState: ApiDrainState = new ApiDrainState(),
  ) {}

  @Get()
  @UseGuards(SessionAuthenticationGuard, NotificationReadGuard)
  public list(
    @Req() request: NotificationsRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workspaceRouteSchema.parse(params);
    const input = workspaceInboxListQuerySchema.parse(query ?? {});
    return mapped(() =>
      this.service.list({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...(input.filter === undefined ? {} : { filter: input.filter }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.after === undefined ? {} : { after: input.after }),
      }),
    );
  }

  @Get('summary')
  @UseGuards(SessionAuthenticationGuard, NotificationReadGuard)
  public summary(
    @Req() request: NotificationsRequest,
    @Param() params: unknown,
  ) {
    const { workspaceId } = workspaceRouteSchema.parse(params);
    return mapped(() =>
      this.service.summary({
        workspaceId,
        actorId: authenticatedSession(request).userId,
      }),
    );
  }

  @Post('read-all')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    NotificationReadGuard,
    CsrfProtectionGuard,
  )
  public readAll(
    @Req() request: NotificationsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workspaceRouteSchema.parse(params);
    const { revision } = workspaceInboxReadAllRequestSchema.parse(body);
    return mapped(() =>
      this.service.markAllRead({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        revision,
      }),
    );
  }

  @Post(':workflowId/read')
  @HttpCode(200)
  @RateLimit('ordinary_mutation')
  @UseGuards(
    SessionAuthenticationGuard,
    NotificationReadGuard,
    CsrfProtectionGuard,
  )
  public read(
    @Req() request: NotificationsRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workspaceInboxThreadParamsSchema.parse(params);
    const { revision } = workspaceInboxReadRequestSchema.parse(body);
    return mapped(() =>
      this.service.markRead({
        workspaceId: route.workspaceId,
        actorId: authenticatedSession(request).userId,
        workflowId: route.workflowId,
        revision,
      }),
    );
  }

  @Get('events')
  @UseGuards(SessionAuthenticationGuard, NotificationReadGuard)
  public async events(
    @Req() request: NotificationsRequest,
    @Param() params: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const controller = new AbortController();
    const onClose = (): void => {
      controller.abort();
    };
    request.raw?.once('close', onClose);
    const releaseDrainRegistration = this.drainState.registerStream(controller);
    const lifetimeController = new AbortController();
    let subscription: InboxHintSubscription | undefined;
    let lifetime:
      ReturnType<typeof createStreamAuthorizationLifetime> | undefined;
    try {
      const { workspaceId } = workspaceRouteSchema.parse(params);
      subscription = await this.hints.subscribe(workspaceId);
      lifetime = createStreamAuthorizationLifetime(
        {
          actor: projectAuthenticatedWorkspaceContext(request, workspaceId)
            .actor,
          routeWorkspaceId: workspaceId,
          capability: 'notification:read',
          allowedWorkspaceStatuses: ['active'],
          sessionExpiresAt: authenticatedSession(request).expiresAt,
          reauthorizeSession: sessionReauthorization(request),
          abortStream: (reason?: unknown) => {
            controller.abort(reason);
          },
          signal: controller.signal,
        },
        this.authorization,
        STREAM_REAUTHORIZATION_INTERVAL_MS,
        lifetimeController,
      );
      prepareSseResponse(reply);
      await writeInboxHintStream(
        subscription,
        reply.raw,
        lifetime,
        controller.signal,
      );
    } catch (error: unknown) {
      controller.abort();
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      throwApplicationError(mapNotificationError(error));
    } finally {
      subscription?.close();
      await lifetime?.stop();
      request.raw?.off('close', onClose);
      releaseDrainRegistration();
    }
  }
}

async function mapped<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error: unknown) {
    return throwApplicationError(mapNotificationError(error));
  }
}

function sessionReauthorization(
  request: NotificationsRequest,
): NonNullable<NotificationsRequest['reauthorizeIdentitySession']> {
  if (request.reauthorizeIdentitySession === undefined)
    return throwApplicationError(applicationError('auth.unauthenticated'));
  return request.reauthorizeIdentitySession;
}
