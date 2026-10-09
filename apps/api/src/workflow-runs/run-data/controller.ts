import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  workflowNodeRunParamsSchema,
  workflowRunParamsSchema,
  workflowStepHealthParamsSchema,
  workflowStepRunsParamsSchema,
  workflowStepRunsQuerySchema,
} from '@pertexo/contracts';

import { SessionAuthenticationGuard } from '../../workspaces/index.js';
import { optionalAuthorizedWorkspace } from '../../workspaces/request/authenticated-context.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  actorFrom,
  type WorkflowRunsRequest,
} from '../http/request-context.js';
import { WorkflowRunReadGuard } from '../http/guards.js';
import {
  GetWorkflowNodeRunInputUseCase,
  GetWorkflowNodeRunOutputUseCase,
  GetWorkflowRunInputUseCase,
  GetWorkflowStepHealthUseCase,
  ListWorkflowStepRunsUseCase,
} from './use-cases.js';

/**
 * A run's input and each step's output (ADR 050), and each step across its
 * workflow's recent runs (ADR 051).
 */
@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowRunDataController {
  public constructor(
    private readonly getRunInput: GetWorkflowRunInputUseCase,
    private readonly getNodeRunOutput: GetWorkflowNodeRunOutputUseCase,
    private readonly getNodeRunInput: GetWorkflowNodeRunInputUseCase,
    private readonly getStepHealth: GetWorkflowStepHealthUseCase,
    private readonly listStepRuns: ListWorkflowStepRunsUseCase,
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

  @Get('runs/:runId/node-runs/:nodeRunId/input')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getNodeInput(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowNodeRunParamsSchema.parse(params);
    return this.getNodeRunInput.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
      nodeRunId: route.nodeRunId,
    });
  }

  @Get('workflows/:workflowId/step-health')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getWorkflowStepHealth(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowStepHealthParamsSchema.parse(params);
    return this.getStepHealth.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      workflowId: route.workflowId,
    });
  }

  @Get('workflows/:workflowId/steps/:nodeId/runs')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async listWorkflowStepRuns(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = workflowStepRunsParamsSchema.parse(params);
    const { limit } = workflowStepRunsQuerySchema.parse(query);
    return this.listStepRuns.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      workflowId: route.workflowId,
      nodeId: route.nodeId,
      ...(limit === undefined ? {} : { limit }),
    });
  }
}
