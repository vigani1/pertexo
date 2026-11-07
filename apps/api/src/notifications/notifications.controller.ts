import {
  Controller,
  Inject,
  Optional,
  Req,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import {
  inboxRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import type { FastifyReply } from 'fastify';

import { projectAuthenticatedWorkspaceContext } from '../workspaces/request/authenticated-context.js';
import { authenticatedSession } from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { WorkspaceAuthorizationSource } from '../workspaces/ports.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { ApiDrainState } from '../platform/health/drain-state.js';
import {
  applicationError,
  throwApplicationError,
} from '../platform/http/index.js';
import { prepareSseResponse } from '../platform/http/sse-response.js';
import { BROWSABLE_WORKSPACE_STATUSES } from '../authorization/index.js';
import { createStreamAuthorizationLifetime } from '../workflow-runs/events/sse-authorization-lifetime.js';

import { writeInboxHintStream } from './hint-stream.js';
import type {
  InboxHintSource,
  InboxHintSubscription,
} from './inbox-hint-hub.js';
import { WorkspaceInboxService } from './workspace-inbox.service.js';
import { INBOX_HINT_SOURCE, NOTIFICATION_AUTHORIZATION } from './tokens.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { inboxFailure } from '../problems/context/normalize-context-errors.js';

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
@UseInterceptors(domainErrors(inboxFailure))
@Controller()
export class NotificationsController {
  public constructor(
    private readonly service: WorkspaceInboxService,
    @Inject(INBOX_HINT_SOURCE) private readonly hints: InboxHintSource,
    @Inject(NOTIFICATION_AUTHORIZATION)
    private readonly authorization: WorkspaceAuthorizationSource,
    @Optional()
    private readonly drainState: ApiDrainState = new ApiDrainState(),
  ) {}

  @Route(routes.list)
  public async list(
    @Req() request: NotificationsRequest,
    @In() { params, query: input }: RouteInput<typeof routes.list>,
  ) {
    return this.service.list({
      workspaceId: params.workspaceId,
      actorId: authenticatedSession(request).userId,
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.noticeKind === undefined
        ? {}
        : { noticeKind: input.noticeKind }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
    });
  }

  @Route(routes.summary)
  public async summary(
    @Req() request: NotificationsRequest,
    @In() { params }: RouteInput<typeof routes.summary>,
  ) {
    return this.service.summary({
      workspaceId: params.workspaceId,
      actorId: authenticatedSession(request).userId,
    });
  }

  @Route(routes.readAll)
  public async readAll(
    @Req() request: NotificationsRequest,
    @In() { params, body }: RouteInput<typeof routes.readAll>,
  ) {
    return this.service.markAllRead({
      workspaceId: params.workspaceId,
      actorId: authenticatedSession(request).userId,
      revision: body.revision,
    });
  }

  @Route(routes.read)
  public async read(
    @Req() request: NotificationsRequest,
    @In() { params, body }: RouteInput<typeof routes.read>,
  ) {
    return this.service.markRead({
      workspaceId: params.workspaceId,
      actorId: authenticatedSession(request).userId,
      threadId: params.threadId,
      revision: body.revision,
    });
  }

  @Route(routes.events)
  public async events(
    @Req() request: NotificationsRequest,
    @In() { params }: RouteInput<typeof routes.events>,
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
      const { workspaceId } = params;
      subscription = await this.hints.subscribe(workspaceId);
      lifetime = createStreamAuthorizationLifetime(
        {
          actor: projectAuthenticatedWorkspaceContext(request, workspaceId)
            .actor,
          routeWorkspaceId: workspaceId,
          capability: 'workspace:read',
          allowedWorkspaceStatuses: BROWSABLE_WORKSPACE_STATUSES,
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
      await writeInboxHintStream(subscription, reply.raw, {
        authorization: lifetime,
        signal: controller.signal,
      });
    } catch (error: unknown) {
      controller.abort();
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      throw error;
    } finally {
      subscription?.close();
      await lifetime?.stop();
      request.raw?.off('close', onClose);
      releaseDrainRegistration();
    }
  }
}

function sessionReauthorization(
  request: NotificationsRequest,
): NonNullable<NotificationsRequest['reauthorizeIdentitySession']> {
  if (request.reauthorizeIdentitySession === undefined)
    return throwApplicationError(applicationError('auth.unauthenticated'));
  return request.reauthorizeIdentitySession;
}
