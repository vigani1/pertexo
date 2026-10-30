import { workflowParams, requestContext, traceparent } from './context.js';

import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { withRequestOperationSignal } from '../../platform/http/request-operation-signal.js';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';

import {
  parseRequestBody,
  requestIdempotencyKey,
} from '../../platform/http/index.js';
import { requestHeaderValue } from '../../platform/http/request-headers.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { TransitionWorkflowLifecycleUseCase } from '../commands/lifecycle.js';
import { RenameWorkflowUseCase } from '../commands/rename.js';
import { DuplicateWorkflowUseCase } from '../commands/duplicate.js';
import { workflowDuplicateRequestSchema } from '@pertexo/contracts';

import {
  WorkflowCreateGuard,
  WorkflowPublishGuard,
  WorkflowParticipantGuard,
  WorkflowUpdateGuard,
} from './guards.js';
import { parseStrongIfMatch } from './preconditions.js';

import type { WorkflowAuthoringRequest, WorkflowResponse } from '../types.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { authoringFailure } from '../../problems/context/normalize.js';
@UseInterceptors(domainErrors(authoringFailure))
@Controller('v1/workspaces/:workspaceId/workflows')
@RateLimit('authenticated_read')
export class WorkflowLifecycleController {
  public constructor(
    private readonly transitionLifecycle: TransitionWorkflowLifecycleUseCase,
    private readonly renameWorkflow: RenameWorkflowUseCase,
    private readonly duplicateWorkflow: DuplicateWorkflowUseCase,
  ) {}
  @Post(':workflowId/archive')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public archive(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycleCommand('archive', request, params, body);
  }
  @Post(':workflowId/restore')
  @RateLimit('ordinary_mutation')
  @HttpCode(202)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public restore(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    return this.lifecycleCommand('restore', request, params, body);
  }
  @Post(':workflowId/rename')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public rename(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    const route = workflowParams(params);
    return this.renameWorkflow.execute({
      ...requestContext(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      request: body,
      idempotencyKey: requestIdempotencyKey(request.headers),
    });
  }
  @Post(':workflowId/duplicate')
  @RateLimit('ordinary_mutation')
  @HttpCode(201)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowParticipantGuard,
    WorkflowCreateGuard,
    CsrfProtectionGuard,
  )
  public async duplicate(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: WorkflowResponse,
  ) {
    const route = workflowParams(params);
    const input = parseRequestBody(workflowDuplicateRequestSchema, body);
    const representationTag =
      input.source.kind === 'draft'
        ? parseStrongIfMatch(requestHeaderValue(request.headers, 'if-match'))
        : undefined;
    const context = requestContext(request, route.workspaceId);
    const result = await withRequestOperationSignal(request, (signal) =>
      this.duplicateWorkflow.execute({
        ...context,
        routeWorkspaceId: route.workspaceId,
        workflowId: route.workflowId,
        request: input,
        idempotencyKey: requestIdempotencyKey(request.headers),
        ...(representationTag === undefined ? {} : { representationTag }),
        signal,
      }),
    );
    response.header(
      'Location',
      `/v1/workspaces/${route.workspaceId}/workflows/${result.workflowId}`,
    );
    return result;
  }
  private lifecycleCommand(
    command: 'archive' | 'restore',
    request: WorkflowAuthoringRequest,
    params: unknown,
    body: unknown,
  ) {
    const route = workflowParams(params);
    const context = requestContext(request, route.workspaceId);
    return this.transitionLifecycle.execute({
      command,
      ...context,
      routeWorkspaceId: route.workspaceId,
      workflowId: route.workflowId,
      request: body,
      idempotencyKey: requestIdempotencyKey(request.headers),
      ...traceparent(request),
    });
  }
}
