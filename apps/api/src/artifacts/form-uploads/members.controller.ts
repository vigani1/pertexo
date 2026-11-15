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

type MemberRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class MemberFormUploadsController {
  constructor(private readonly uploads: FormUploadService) {}

  @Route(routes.memberBegin)
  begin(
    @Req() request: MemberRequest,
    @Caller() caller: WorkspaceCaller,
    @In()
    {
      params,
      body,
      idempotencyKey,
      headers,
    }: RouteInput<typeof routes.memberBegin>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.begin({
        target: memberTarget(caller, params),
        session: headers['x-pertexo-form-session'],
        ...body,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Route(routes.memberFinalize)
  finalize(
    @Req() request: MemberRequest,
    @Caller() caller: WorkspaceCaller,
    @In() { params, headers }: RouteInput<typeof routes.memberFinalize>,
  ) {
    const { uploadId, ...scope } = params;
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.finalize({
        target: memberTarget(caller, scope),
        session: headers['x-pertexo-form-session'],
        uploadId,
        signal,
      }),
    );
  }
}

function memberTarget(
  caller: WorkspaceCaller,
  {
    workspaceId,
    workflowId,
  }: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return {
    kind: 'member_form' as const,
    workspaceId,
    workflowId,
    actorId: caller.actor.actorId,
  };
}
