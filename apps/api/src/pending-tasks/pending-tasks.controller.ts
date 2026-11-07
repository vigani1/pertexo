import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  pendingTaskRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { authenticatedSession } from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { PendingTaskService } from './pending-task.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize-context-errors.js';

type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class PendingTasksController {
  constructor(private readonly tasks: PendingTaskService) {}

  @Route(routes.list)
  list(
    @Req() request: TaskRequest,
    @In() { params, query }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.list({ ...asker(request, params), ...query, signal }),
    );
  }

  @Route(routes.audience)
  audience(
    @Req() request: TaskRequest,
    @In() { params, query }: RouteInput<typeof routes.audience>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.audience({ ...asker(request, params), ...query, signal }),
    );
  }

  @Route(routes.inspectAudience)
  inspectAudience(
    @Req() request: TaskRequest,
    @In() { params, body }: RouteInput<typeof routes.inspectAudience>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.inspectAudience({
        ...asker(request, params),
        ...body,
        signal,
      }),
    );
  }

  @Route(routes.read)
  read(
    @Req() request: TaskRequest,
    @In() { params }: RouteInput<typeof routes.read>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.read({ ...asker(request, params), ...params, signal }),
    );
  }

  @Route(routes.decide)
  decide(
    @Req() request: TaskRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.decide>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.decide({
        ...asker(request, params),
        ...params,
        ...body,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }

  @Route(routes.submit)
  submit(
    @Req() request: TaskRequest,
    @In()
    { params, body, idempotencyKey, headers }: RouteInput<typeof routes.submit>,
  ) {
    const uploadSession = headers['x-pertexo-form-session'];
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.submit({
        ...asker(request, params),
        ...params,
        ...body,
        ...(uploadSession === undefined ? {} : { uploadSession }),
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}

function asker(
  request: TaskRequest,
  { workspaceId }: Readonly<{ workspaceId: string }>,
) {
  return { workspaceId, actorId: authenticatedSession(request).userId };
}
