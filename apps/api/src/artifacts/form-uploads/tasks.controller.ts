import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  formUploadRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize-context-errors.js';
import { FormUploadService } from './form-upload.service.js';
import {
  Caller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;

/** Request input responders upload on the task page, as its eligible members. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class InputRequestUploadsController {
  constructor(private readonly uploads: FormUploadService) {}

  @Route(routes.taskBegin)
  begin(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      params,
      body,
      idempotencyKey,
      headers,
    }: RouteInput<typeof routes.taskBegin>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.begin({
        target: taskTarget(caller, params),
        session: headers['x-pertexo-form-session'],
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.taskFinalize)
  finalize(
    @Req() request: TaskRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, headers }: RouteInput<typeof routes.taskFinalize>,
  ) {
    const { uploadId, ...scope } = params;
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.finalize({
        target: taskTarget(caller, scope),
        session: headers['x-pertexo-form-session'],
        uploadId,
        signal,
      }),
    );
  }
}

function taskTarget(
  caller: WorkspaceCaller,
  { workspaceId, taskId }: Readonly<{ workspaceId: string; taskId: string }>,
) {
  return {
    kind: 'input_request' as const,
    workspaceId,
    taskId,
    actorId: caller.actor.actorId,
  };
}
