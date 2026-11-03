import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  webhookRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { authenticatedSession } from '../../workspaces/index.js';
import { In, Route } from '../../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { WebhookTestEventService } from './webhook-test-event.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';

type Request = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(authoringFailure))
@Controller()
export class WebhookTestEventController {
  constructor(private readonly service: WebhookTestEventService) {}

  @Route(routes.startTest)
  start(
    @Req() request: Request,
    @In() { params, body }: RouteInput<typeof routes.startTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.start({
        ...params,
        ...body,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }

  @Route(routes.readTest)
  get(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.readTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.get({
        ...params,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }

  @Route(routes.stopTest)
  stop(
    @Req() request: Request,
    @In() { params }: RouteInput<typeof routes.stopTest>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.service.stop({
        ...params,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
}
