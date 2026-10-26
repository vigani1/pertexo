import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  formCapabilitySchema,
  formFinalizeUploadRequestSchema,
  formUploadRequestSchema,
  publicFormParamsSchema,
  publicFormUploadParamsSchema,
} from '@pertexo/contracts';
import { firstRequestHeader } from '../../platform/http/request-headers.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { HttpRateLimitAdmission } from '../../platform/rate-limit/admission.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize.js';
import { FormUploadService } from './service.js';
import { uploadSession } from './session.js';

type PublicRequest = FastifyRequest & AbortableRequest;

/** Anyone with the link may upload, so each request spends the upload budget too. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller('v1/forms/:publicId/uploads')
@RateLimit('form_read')
export class PublicFormUploadsController {
  constructor(
    private readonly uploads: FormUploadService,
    private readonly limits: HttpRateLimitAdmission,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  begin(
    @Req() request: PublicRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { publicId } = publicFormParamsSchema.parse(params);
    const input = formUploadRequestSchema.parse(body);
    const responder = this.responder(request);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, async (signal) => {
      const target = await this.admit(request, publicId, responder, signal);
      return this.uploads.begin({
        target,
        session: responder.session,
        ...input,
        idempotencyKey,
        signal,
      });
    });
  }

  @Post(':uploadId/finalize')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  finalize(
    @Req() request: PublicRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { publicId, uploadId } = publicFormUploadParamsSchema.parse(params);
    formFinalizeUploadRequestSchema.parse(body);
    const responder = this.responder(request);
    return withRequestOperationSignal(request, async (signal) => {
      const target = await this.admit(request, publicId, responder, signal);
      return this.uploads.finalize({
        target,
        session: responder.session,
        uploadId,
        signal,
      });
    });
  }

  private responder(request: PublicRequest) {
    return {
      capability: formCapabilitySchema.parse(
        firstRequestHeader(request.headers, 'x-pertexo-form-key'),
      ),
      session: uploadSession(request.headers),
    };
  }

  private async admit(
    request: PublicRequest,
    publicId: string,
    responder: Readonly<{ capability: string }>,
    signal: AbortSignal,
  ) {
    const grant = await this.uploads.discover({
      publicId,
      capability: responder.capability,
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
