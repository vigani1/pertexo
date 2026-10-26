import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  publicFormParamsSchema,
  formCapabilitySchema,
  formSubmissionRequestSchema,
} from '@pertexo/contracts';
import { firstRequestHeader } from '../platform/http/request-headers.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { HttpRateLimitAdmission } from '../platform/rate-limit/admission.js';
import { FormService } from './service.js';
import { optionalUploadSession } from '../artifacts/form-uploads/session.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { formFailure } from '../problems/context/normalize.js';

type PublicRequest = FastifyRequest & AbortableRequest;
@UseInterceptors(domainErrors(formFailure))
@Controller('v1/forms/:publicId')
@RateLimit('form_read')
export class PublicFormsController {
  constructor(
    private readonly forms: FormService,
    private readonly limits: HttpRateLimitAdmission,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  read(@Req() request: PublicRequest, @Param() params: unknown) {
    const { publicId } = publicFormParamsSchema.parse(params);
    const capability = formCapabilitySchema.parse(
      firstRequestHeader(request.headers, 'x-pertexo-form-key'),
    );
    return withRequestOperationSignal(request, async (signal) => {
      const grant = await this.forms.discover({ publicId, capability, signal });
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
  @Post('submit')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @RateLimit('form_submission')
  submit(
    @Req() request: PublicRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { publicId } = publicFormParamsSchema.parse(params);
    const capability = formCapabilitySchema.parse(
      firstRequestHeader(request.headers, 'x-pertexo-form-key'),
    );
    const input = formSubmissionRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, async (signal) => {
      const grant = await this.forms.discover({ publicId, capability, signal });
      await this.limits.admit('form_workspace_submission', {
        workspaceId: grant.workspaceId,
      });
      return this.forms.submit(
        {
          workspaceId: grant.workspaceId,
          workflowId: grant.workflowId,
          ...input,
          ...optionalUploadSession(request.headers),
          idempotencyKey,
          signal,
        },
        grant,
      );
    });
  }
}
