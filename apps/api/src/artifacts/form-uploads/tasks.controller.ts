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
  taskUploadParamsSchema,
  taskUploadRequestSchema,
  taskUploadsParamsSchema,
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
import { InputRequestResponderGuard } from '../guards.js';
import { uploadSession } from './session.js';
import { FormUploadService } from './service.js';

type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;

/** Request input responders upload on the task page, as its eligible members. */
@UseInterceptors(domainErrors(formUploadFailure))
@Controller('v1/workspaces/:workspaceId/pending-tasks/:taskId/uploads')
@UseGuards(
  SessionAuthenticationGuard,
  InputRequestResponderGuard,
  CsrfProtectionGuard,
)
@RateLimit('ordinary_mutation')
export class InputRequestUploadsController {
  constructor(private readonly uploads: FormUploadService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  begin(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const scope = taskUploadsParamsSchema.parse(params);
    const input = taskUploadRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.begin({
        target: taskTarget(request, scope),
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
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { uploadId, ...scope } = taskUploadParamsSchema.parse(params);
    formFinalizeUploadRequestSchema.parse(body);
    return withRequestOperationSignal(request, (signal) =>
      this.uploads.finalize({
        target: taskTarget(request, scope),
        session: uploadSession(request.headers),
        uploadId,
        signal,
      }),
    );
  }
}

function taskTarget(
  request: TaskRequest,
  scope: Readonly<{ workspaceId: string; taskId: string }>,
) {
  return {
    kind: 'input_request' as const,
    ...scope,
    actorId: authenticatedSession(request).userId,
  };
}
