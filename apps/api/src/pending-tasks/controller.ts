import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { z } from 'zod';
import {
  pendingTaskParamsSchema,
  pendingTaskListQuerySchema,
  pendingTaskDecisionRequestSchema,
  pendingTaskSubmitRequestSchema,
  approvalAudienceQuerySchema,
  approvalAudienceInspectionRequestSchema,
} from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
  authenticatedSession,
} from '../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../workspaces/types.js';
import {
  parseRequestBody,
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { authenticatedRequestIdentifiers } from '../workspaces/request/authenticated-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { optionalUploadSession } from '../artifacts/form-uploads/session.js';
import { PendingTaskReadGuard, ApprovalAudienceGuard } from './guards.js';
import { PendingTaskService } from './service.js';
import { domainErrors } from '../platform/http/problems/interceptor.js';
import { resourceFailure } from '../problems/context/normalize.js';

const workspaceParams = z.object({ workspaceId: z.uuid() }).strict();
type TaskRequest = IdentityWorkspaceRequest & AbortableRequest;
@UseInterceptors(domainErrors(resourceFailure))
@Controller('v1/workspaces/:workspaceId/pending-tasks')
@RateLimit('authenticated_read')
@UseGuards(SessionAuthenticationGuard)
export class PendingTasksController {
  constructor(private readonly tasks: PendingTaskService) {}
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(PendingTaskReadGuard)
  list(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workspaceParams.parse(params);
    const input = pendingTaskListQuerySchema.parse(query ?? {});
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.list({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        signal,
      }),
    );
  }
  @Get('audience')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ApprovalAudienceGuard)
  audience(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const { workspaceId } = workspaceParams.parse(params);
    const input = approvalAudienceQuerySchema.parse(query ?? {});
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.audience({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        signal,
      }),
    );
  }
  @Post('audience/inspect')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(ApprovalAudienceGuard, CsrfProtectionGuard)
  inspectAudience(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const { workspaceId } = workspaceParams.parse(params);
    const input = parseRequestBody(
      approvalAudienceInspectionRequestSchema,
      body,
    );
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.inspectAudience({
        workspaceId,
        actorId: authenticatedSession(request).userId,
        ...input,
        signal,
      }),
    );
  }
  @Get(':taskId')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(PendingTaskReadGuard)
  read(@Req() request: TaskRequest, @Param() params: unknown) {
    const route = pendingTaskParamsSchema.parse(params);
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.read({
        ...route,
        actorId: authenticatedSession(request).userId,
        signal,
      }),
    );
  }
  @Post(':taskId/decide')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @UseGuards(PendingTaskReadGuard, CsrfProtectionGuard)
  decide(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = pendingTaskParamsSchema.parse(params);
    const input = parseRequestBody(pendingTaskDecisionRequestSchema, body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.decide({
        ...route,
        ...input,
        actorId: authenticatedSession(request).userId,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
  @Post(':taskId/submit')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('ordinary_mutation')
  @UseGuards(PendingTaskReadGuard, CsrfProtectionGuard)
  submit(
    @Req() request: TaskRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = pendingTaskParamsSchema.parse(params);
    const input = parseRequestBody(pendingTaskSubmitRequestSchema, body);
    const idempotencyKey = requestIdempotencyKey(request.headers);
    return withRequestOperationSignal(request, (signal) =>
      this.tasks.submit({
        ...route,
        ...input,
        ...optionalUploadSession(request.headers),
        actorId: authenticatedSession(request).userId,
        idempotencyKey,
        ...authenticatedRequestIdentifiers(request),
        signal,
      }),
    );
  }
}
