import { requestIdempotencyKey } from '../../platform/http/index.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { workflowIdParamSchema } from '@pertexo/contracts';
import {
  CsrfProtectionGuard,
  SessionAuthenticationGuard,
} from '../../workspaces/index.js';
import { projectAuthenticatedWorkspaceContext } from '../../workspaces/request/authenticated-context.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import { WorkflowAutoPauseUseCase } from './auto-pause.js';
import { throwWorkflowApplicationError } from '../errors.js';
import {
  WorkflowReadGuard,
  WorkflowUpdateGuard,
  WorkflowPublishGuard,
  WorkflowPauseDefaultGuard,
  WorkspaceAutoPauseReadGuard,
} from '../http/guards.js';
import type { WorkflowAuthoringRequest } from '../types.js';

const workspaceParamsSchema = workflowIdParamSchema
  .pick({ workspaceId: true })
  .strict();

@Controller('v1/workspaces/:workspaceId/workflows/:workflowId')
@RateLimit('authenticated_read')
export class WorkflowAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseUseCase) {}

  @Get('auto-pause')
  @UseGuards(SessionAuthenticationGuard, WorkflowReadGuard)
  public async read(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await this.controls.readWorkflow({
        ...context(request, workspaceId),
        workflowId,
      });
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Put('auto-pause')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowUpdateGuard,
    CsrfProtectionGuard,
  )
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await this.controls.updateWorkflow({
        ...command(request, workspaceId, body),
        workflowId,
      });
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Post('resume')
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPublishGuard,
    CsrfProtectionGuard,
  )
  public async resume(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId, workflowId } = workflowIdParamSchema.parse(params);
      return await this.controls.resume({
        ...command(request, workspaceId, body),
        workflowId,
      });
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }
}

@Controller('v1/workspaces/:workspaceId/auto-pause')
@RateLimit('authenticated_read')
export class WorkspaceAutoPauseController {
  public constructor(private readonly controls: WorkflowAutoPauseUseCase) {}

  @Get()
  @UseGuards(SessionAuthenticationGuard, WorkspaceAutoPauseReadGuard)
  public async read(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
  ) {
    try {
      const { workspaceId } = workspaceParamsSchema.parse(params);
      return await this.controls.readWorkspace(context(request, workspaceId));
    } catch (error) {
      return throwWorkflowApplicationError(error);
    }
  }

  @Put()
  @RateLimit('ordinary_mutation')
  @HttpCode(200)
  @UseGuards(
    SessionAuthenticationGuard,
    WorkflowPauseDefaultGuard,
    CsrfProtectionGuard,
  )
  public async update(
    @Req() request: WorkflowAuthoringRequest,
    @Param() params: unknown,
    @Body() body: unknown,
  ) {
    try {
      const { workspaceId } = workspaceParamsSchema.parse(params);
      return await this.controls.updateWorkspace(
        command(request, workspaceId, body),
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

function command(
  request: WorkflowAuthoringRequest,
  workspaceId: string,
  body: unknown,
) {
  return {
    ...context(request, workspaceId),
    request: body,
    idempotencyKey: requestIdempotencyKey(request.headers),
  };
}
