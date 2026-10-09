import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { workflowIdParamSchema } from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../identity-workspace/index.js';
import { projectAuthenticatedWorkspaceContext } from '../identity-workspace/authenticated-command-context.js';
import { withRequestOperationSignal } from '../platform/http/index.js';
import type { AbortableRequest } from '../platform/http/request-operation-signal.js';
import { requestHeaderValue } from '../platform/http/request-headers.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { WorkflowConcurrencyUseCase } from './concurrency-use-case.js';
import { throwWorkflowApplicationError } from './errors.js';
import { WorkflowReadGuard, WorkflowUpdateGuard } from './guards.js';
import { parseIdempotencyKey } from './preconditions.js';
import type { WorkflowAuthoringRequest } from './types.js';

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId/concurrency')
@RateLimit('authenticated_read')
export class WorkflowConcurrencyController {
  public constructor(private readonly controls: WorkflowConcurrencyUseCase) {}
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
      const idempotencyKey = parseIdempotencyKey(
        requestHeaderValue(request.headers, 'idempotency-key'),
      );
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
