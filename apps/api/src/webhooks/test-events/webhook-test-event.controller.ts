import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  webhookRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WebhookTestEventService } from './webhook-test-event.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WebhookTestEventController {
  constructor(private readonly service: WebhookTestEventService) {}

  @Route(routes.startTest)
  start(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body }: RouteInput<typeof routes.startTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.start({
        ...params,
        ...body,
        actorId: caller.actor.actorId,
        signal,
      }),
    );
  }

  @Route(routes.readTest)
  get(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.readTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.get({
        ...params,
        actorId: caller.actor.actorId,
        signal,
      }),
    );
  }

  @Route(routes.stopTest)
  stop(
    @Req() request: Request,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.stopTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.stop({
        ...params,
        actorId: caller.actor.actorId,
        signal,
      }),
    );
  }
}
