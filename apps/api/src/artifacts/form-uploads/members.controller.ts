import {
  Body,
  Controller,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  formFinalizeUploadRequestSchema,
  formParamsSchema,
  formUploadRequestSchema,
  memberFormUploadParamsSchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { formUploadFailure } from '../../problems/context/normalize.js';
import { FormResponderGuard } from '../guards.js';
import { FormUploadService } from './service.js';
import { uploadSession } from './session.js';

type MemberRequest = IdentityWorkspaceRequest & AbortableRequest;

@UseInterceptors(domainErrors(formUploadFailure))
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/form/uploads')
@UseGuards(SessionAuthenticationGuard, FormResponderGuard, CsrfProtectionGuard)
@RateLimit('ordinary_mutation')
export class MemberFormUploadsController {
  constructor(private readonly uploads: FormUploadService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  begin(
    @Req() request: MemberRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const scope = formParamsSchema.parse(params);
    const input = formUploadRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.begin({
        target: memberTarget(request, scope),
        session: uploadSession(request.headers),
        ...input,
        idempotencyKey,
        signal,
      }),
    );
  }

  @Post(':uploadId/finalize')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  finalize(
    @Req() request: MemberRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { uploadId, ...scope } = memberFormUploadParamsSchema.parse(params);
    formFinalizeUploadRequestSchema.parse(body);
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.finalize({
        target: memberTarget(request, scope),
        session: uploadSession(request.headers),
        uploadId,
        signal,
      }),
    );
  }
}

function memberTarget(
  request: MemberRequest,
  scope: Readonly<{ workspaceId: string; workflowId: string }>,
) {
  return {
    kind: 'member_form' as const,
    ...scope,
    actorId: authenticatedSession(request).userId,
  };
}
