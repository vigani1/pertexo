import { Controller, Req, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  formRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../workspaces/http/route.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { HttpRateLimitAdmission } from '../platform/rate-limit/admission.js';
import { FormService } from './service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { formFailure } from '../problems/context/normalize.js';

type PublicRequest = FastifyRequest & AbortableRequest;

/** Anyone with the link: the capability in the header stands in for a session. */
@UseInterceptors(domainErrors(formFailure))
@Controller()
export class PublicFormsController {
  constructor(
    private readonly forms: FormService,
    private readonly limits: HttpRateLimitAdmission,
  ) {}

  @Route(routes.publicRead)
  read(
    @Req() request: PublicRequest,
    @In() { params, headers }: RouteInput<typeof routes.publicRead>,
  ) {
    return withRequestOperationSignal(request, async (signal) => {
      const grant = await this.forms.discover({
        publicId: params.publicId,
        capability: headers['x-pertexo-form-key'],
        signal,
      });
      return this.forms.read(
        {
          workspaceId: grant.workspaceId,
          workflowId: grant.workflowId,
          signal,
        },
        grant,
      );
    });
  }

  @Route(routes.publicSubmit)
  submit(
    @Req() request: PublicRequest,
    @In()
    {
      params,
      body,
      idempotencyKey,
      headers,
    }: RouteInput<typeof routes.publicSubmit>,
  ) {
    const uploadSession = headers['x-pertexo-form-session'];
    return withRequestOperationSignal(request, async (signal) => {
      const grant = await this.forms.discover({
        publicId: params.publicId,
        capability: headers['x-pertexo-form-key'],
        signal,
      });
      await this.limits.admit('form_workspace_submission', {
        workspaceId: grant.workspaceId,
      });
      return this.forms.submit(
        {
          workspaceId: grant.workspaceId,
          workflowId: grant.workflowId,
          ...body,
          ...(uploadSession === undefined ? {} : { uploadSession }),
          idempotencyKey,
          signal,
        },
        grant,
      );
    });
  }
}
