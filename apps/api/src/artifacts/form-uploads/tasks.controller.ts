import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  formUploadRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { authenticatedSession } from '../../workspaces/index.js';
import { In, Route } from '../../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/workspace-transport.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize.js';
import { FormUploadService } from './form-upload.service.js';

type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;

/** Request input responders upload on the task page, as its eligible members. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class InputRequestUploadsController {
  constructor(private readonly uploads: FormUploadService) {}

  @Route(routes.taskBegin)
  begin(
    @Req() request: TaskRequest,
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
        target: taskTarget(request, params),
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
    @In() { params, headers }: RouteInput<typeof routes.taskFinalize>,
  ) {
    const { uploadId, ...scope } = params;
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.finalize({
        target: taskTarget(request, scope),
        session: headers['x-pertexo-form-session'],
        uploadId,
        signal,
      }),
    );
  }
}

function taskTarget(
  request: TaskRequest,
  { workspaceId, taskId }: Readonly<{ workspaceId: string; taskId: string }>,
) {
  return {
    kind: 'input_request' as const,
    workspaceId,
    taskId,
    actorId: authenticatedSession(request).userId,
  };
}
