import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import {
  workflowNodeRunParamsSchema,
  workflowRunParamsSchema,
} from '@pertexo/contracts/workflow-runs';

import { SessionAuthenticationGuard } from '../identity-workspace/index.js';
import { optionalAuthorizedWorkspace } from '../identity-workspace/authenticated-command-context.js';
import { RateLimit } from '../platform/rate-limit/metadata.js';
import { actorFrom, type WorkflowRunsRequest } from './controllers.js';
import { WorkflowRunReadGuard } from './guards.js';
import {
  GetWorkflowNodeRunOutputUseCase,
  GetWorkflowRunInputUseCase,
} from './run-data-use-cases.js';

/** A run's input and each step's output (ADR 050). */
@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowRunDataController {
  public constructor(
    private readonly getRunInput: GetWorkflowRunInputUseCase,
    private readonly getNodeRunOutput: GetWorkflowNodeRunOutputUseCase,
  ) {}

  @Get('runs/:runId/input')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getInput(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    return this.getRunInput.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
    });
  }

  @Get('runs/:runId/node-runs/:nodeRunId/output')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getOutput(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowNodeRunParamsSchema.parse(params);
    return this.getNodeRunOutput.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
      nodeRunId: route.nodeRunId,
    });
  }
}
