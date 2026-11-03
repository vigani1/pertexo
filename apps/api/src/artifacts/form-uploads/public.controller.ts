import { Controller, Req, UseInterceptors } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  formUploadRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';
import { In, Route } from '../../workspaces/http/route.js';
import { withRequestOperationSignal } from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { HttpRateLimitAdmission } from '../../platform/rate-limit/admission.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize.js';
import { FormUploadService } from './service.js';

type PublicRequest = FastifyRequest & AbortableRequest;

/** Anyone with the link may upload, so each request spends the upload budget too. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller()
export class PublicFormUploadsController {
  constructor(
    private readonly uploads: FormUploadService,
    private readonly limits: HttpRateLimitAdmission,
  ) {}

  @Route(routes.publicBegin)
  begin(
    @Req() request: PublicRequest,
    @In()
    {
      params,
      body,
      idempotencyKey,
      headers,
    }: RouteInput<typeof routes.publicBegin>,
  ) {
    return withRequestOperationSignal(request, async (signal) => {
      const target = await this.admit(
        request,
        params.publicId,
        headers,
        signal,
      );
      return this.uploads.begin({
        target,
        session: headers['x-pertexo-form-session'],
        ...body,
        idempotencyKey,
        signal,
      });
    });
  }

  @Route(routes.publicFinalize)
  finalize(
    @Req() request: PublicRequest,
    @In() { params, headers }: RouteInput<typeof routes.publicFinalize>,
  ) {
    return withRequestOperationSignal(request, async (signal) => {
      const target = await this.admit(
        request,
        params.publicId,
        headers,
        signal,
      );
      return this.uploads.finalize({
        target,
        session: headers['x-pertexo-form-session'],
        uploadId: params.uploadId,
        signal,
      });
    });
  }

  private async admit(
    request: PublicRequest,
    publicId: string,
    headers: Readonly<{ 'x-pertexo-form-key': string }>,
    signal: AbortSignal,
  ) {
    const grant = await this.uploads.discover({
      publicId,
      capability: headers['x-pertexo-form-key'],
      signal,
    });
    await this.limits.admit('form_upload', {
      clientAddress: request.ip,
      formId: publicId,
      workspaceId: grant.workspaceId,
    });
    return { kind: 'public_form' as const, grant };
  }
}
