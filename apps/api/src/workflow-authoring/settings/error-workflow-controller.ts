import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { workflowIdParamSchema } from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import {
  requestIdempotencyKey,
  withRequestOperationSignal,
} from '../../platform/http/index.js';
import type { AbortableRequest } from '../../platform/http/request-operation-signal.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowErrorUseCase } from './error-workflow.js';
import { throwWorkflowApplicationError } from '../../problems/authoring/workflows.js';
import { WorkflowReadGuard, WorkflowUpdateGuard } from '../http/guards.js';
import type { WorkflowAuthoringRequest } from '../types.js';

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/error-workflow')
@RateLimit('authenticated_read')
export class WorkflowErrorController {
  public constructor(private readonly controls: WorkflowErrorUseCase) {}
  @Get('targets')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowUpdateGuard)
  public async targets(
    @Req() request: WorkflowAuthoringRequest & AbortableRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.targets({
          ...context(request, workspaceId),
          workflowId,
          request: query,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Get()
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async read(
    @Req() request: WorkflowAuthoringRequest & AbortableRequest,
    @Param() params: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.read({
          ...context(request, workspaceId),
          workflowId,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
  @Put()
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async update(
    @Req() request: WorkflowAuthoringRequest & AbortableRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      const idempotencyKey = requestIdempotencyKey(request.headers);
      return await withRequestOperationSignal(request, (signal) =>
        this.controls.update({
          ...context(request, workspaceId),
          workflowId,
          request: body,
          idempotencyKey,
          signal,
        }),
      );
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
}
function context(request: WorkflowAuthoringRequest, workspaceId: string) {
  return {
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    routeWorkspaceId: workspaceId,
  };
}
