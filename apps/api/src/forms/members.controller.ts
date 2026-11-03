import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  formRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { authenticatedSession } from '../workspaces/index.js';
import { In, Route } from '../workspaces/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { FormService } from './form.service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { memberFormFailure } from '../problems/context/normalize.js';

type FormRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(memberFormFailure))
@Controller()
export class MemberFormsController {
  constructor(private readonly forms: FormService) {}

  @Route(routes.read)
  read(
    @Req() request: FormRequest,
    @In() { params }: RouteInput<typeof routes.read>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.forms.read({ ...params, actorId: actorId(request), signal }),
    );
  }

  @Route(routes.submit)
  submit(
    @Req() request: FormRequest,
    @In()
    { params, body, idempotencyKey, headers }: RouteInput<typeof routes.submit>,
  ) {
    const uploadSession = headers['x-pertexo-form-session'];
    return withRequestOperationSignal(request, (signal) =>
      this.forms.submit({
        ...params,
        ...body,
        ...(uploadSession === undefined ? {} : { uploadSession }),
        actorId: actorId(request),
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }

  @Route(routes.events)
  history(
    @Req() request: FormRequest,
    @In() { params, query }: RouteInput<typeof routes.events>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.forms.history({
        ...params,
        ...query,
        actorId: actorId(request),
        signal,
      }),
    );
  }

  @Route(routes.access)
  access(
    @Req() request: FormRequest,
    @In() { params }: RouteInput<typeof routes.access>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.forms.access({ ...params, actorId: actorId(request), signal }),
    );
  }

  @Route(routes.setAccess)
  setAccess(
    @Req() request: FormRequest,
    @In() { params, body, idempotencyKey }: RouteInput<typeof routes.setAccess>,
  ) {
    return withRequestOperationSignal(request, (signal) =>
      this.forms.setAccess({
        ...params,
        ...body,
        actorId: actorId(request),
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}

function actorId(request: FormRequest): string {
  return authenticatedSession(request).userId;
}
