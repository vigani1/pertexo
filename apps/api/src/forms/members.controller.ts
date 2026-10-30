import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Req,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  formParamsSchema,
  formSubmissionRequestSchema,
  formAccessRequestSchema,
  coordinatedEventHistoryQuerySchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import {
  FormManageGuard,
  FormManagerReadGuard,
  FormMemberGuard,
  FormReadGuard,
} from './guards.js';
import { FormService } from './service.js';
import { optionalUploadSession } from '../artifacts/form-uploads/session.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { memberFormFailure } from '../problems/context/normalize.js';

type FormRequest = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(memberFormFailure))
@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/form')
@UseGuards(SessionAuthenticationGuard)
@RateLimit('authenticated_read')
export class MemberFormsController {
  constructor(private readonly forms: FormService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(FormReadGuard)
  read(@Req() request: FormRequest, @Param() params: unknown) {
    const scope = formParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.forms.read({
        ...scope,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Post('submit')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(FormMemberGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  submit(
    @Req() request: FormRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const scope = formParamsSchema.parse(params);
    const input = formSubmissionRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.forms.submit({
        ...scope,
        ...input,
        ...optionalUploadSession(request.headers),
        actorId: authenticatedSession(request).userId,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
  @Get('events')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(FormManagerReadGuard)
  history(
    @Req() request: FormRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const scope = formParamsSchema.parse(params);
    const input = coordinatedEventHistoryQuerySchema.parse(query);
    return withRequestOperationSignal(request, (signal) =>
      this.forms.history({
        ...scope,
        ...input,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Get('access')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(FormManagerReadGuard)
  access(@Req() request: FormRequest, @Param() params: unknown) {
    const scope = formParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.forms.access({
        ...scope,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Post('access')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(FormManageGuard, CsrfProtectionGuard)
  @RateLimit('ordinary_mutation')
  setAccess(
    @Req() request: FormRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const scope = formParamsSchema.parse(params);
    const input = formAccessRequestSchema.parse(body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.forms.setAccess({
        ...scope,
        ...input,
        actorId: authenticatedSession(request).userId,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}
