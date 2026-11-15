import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  notificationPreferenceRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { NoticePreferencesService } from './notice-preferences.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { inboxFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(inboxFailure))
@Controller()
export class NoticePreferencesController {
  constructor(private readonly preferences: NoticePreferencesService) {}

  @Route(routes.read)
  read(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.read>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.read({
        workspaceId: params.workspaceId,
        actorId: caller.actor.actorId,
        signal,
      }),
    );
  }

  @Route(routes.replace)
  replace(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.replace>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replace({
        workspaceId: params.workspaceId,
        actorId: caller.actor.actorId,
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.defaults)
  defaults(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.defaults>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replaceDefaults({
        workspaceId: params.workspaceId,
        actorId: caller.actor.actorId,
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.subscription)
  subscription(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.subscription>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.subscription({
        ...params,
        actorId: caller.actor.actorId,
        signal,
      }),
    );
  }

  @Route(routes.replaceSubscription)
  replaceSubscription(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      params,
      body,
      idempotencyKey,
    }: RouteInput<typeof routes.replaceSubscription>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.preferences.replaceSubscription({
        ...params,
        actorId: caller.actor.actorId,
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }
}
