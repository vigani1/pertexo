import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  pendingTaskRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { PendingTaskService } from './pending-task.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize-context-errors.js';
import {
  Caller,
  storeCaller,
  requestIdentifiers,
  type WorkspaceCaller,
} from '../workspaces/request/caller.js';

type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(resourceFailure))
@Controller()
export class PendingTasksController {
  constructor(private readonly tasks: PendingTaskService) {}

  @Route(routes.list)
  list(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.list>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.list({ ...storeCaller(caller), ...query, signal }),
    );
  }

  @Route(routes.audience)
  audience(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { query }: RouteInput<typeof routes.audience>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.audience({ ...storeCaller(caller), ...query, signal }),
    );
  }

  @Route(routes.inspectAudience)
  inspectAudience(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { body }: RouteInput<typeof routes.inspectAudience>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.inspectAudience({
        ...storeCaller(caller),
        ...body,
        signal,
      }),
    );
  }

  @Route(routes.read)
  read(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.read>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.read({ ...storeCaller(caller), ...params, signal }),
    );
  }

  @Route(routes.decide)
  decide(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.decide>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.decide({
        ...storeCaller(caller),
        ...params,
        ...body,
        idempotencyKey,
        ...requestIdentifiers(caller),
        signal,
      }),
    );
  }

  @Route(routes.submit)
  submit(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    { params, body, idempotencyKey, headers }: RouteInput<typeof routes.submit>,
  ) {
    const uploadSession = headers['x-pertexo-form-session'];
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.submit({
        ...storeCaller(caller),
        ...params,
        ...body,
        ...(uploadSession === undefined ? {} : { uploadSession }),
        idempotencyKey,
        ...requestIdentifiers(caller),
        signal,
      }),
    );
  }
}
