import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  workflowNodeRunParamsSchema,
  workflowRunParamsSchema,
  workflowStepHealthParamsSchema,
  workflowStepRunsParamsSchema,
  workflowStepRunsQuerySchema,
} from '@pertexo/contracts';

import { AutomationAuthenticationGuard } from '../../authentication/automation/guard.js';
import { SessionAuthenticationGuard } from '../../workspaces/index.js';
import { optionalAuthorizedWorkspace } from '../../workspaces/request/authenticated-context.js';
import { RateLimit } from '../../platform/rate-limit/metadata.js';
import {
  actorFrom,
  type WorkflowRunsRequest,
} from '../http/request-context.js';
import {
  WorkflowRunDataReadGuard,
  WorkflowRunReadGuard,
} from '../http/guards.js';
import {
  GetWorkflowNodeRunInputUseCase,
  GetWorkflowNodeRunDiagnosticsUseCase,
  GetWorkflowNodeRunOutputUseCase,
  GetWorkflowRunInputUseCase,
  GetWorkflowRunVariablesUseCase,
  GetWorkflowStepHealthUseCase,
  ListWorkflowStepRunsUseCase,
} from './use-cases.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize.js';
import { parseRequestInput } from '../../platform/http/request-input.js';

/**
 * A run's input and each step's output (ADR 050), and each step across its
 * workflow's recent runs (ADR 051). All of it can hold sensitive data, so no
 * browser or proxy keeps a copy.
 */
@UseInterceptors(domainErrors(runFailure))
@Controller('v1/workspaces/:workspaceId')
@RateLimit('authenticated_read')
export class WorkflowRunDataController {
  // Nest resolves these dependencies positionally; grouping them would change DI.
  // eslint-disable-next-line max-params
  public constructor(
    private readonly getRunInput: GetWorkflowRunInputUseCase,
    private readonly getRunVariables: GetWorkflowRunVariablesUseCase,
    private readonly getNodeRunOutput: GetWorkflowNodeRunOutputUseCase,
    private readonly getNodeRunDiagnostics: GetWorkflowNodeRunDiagnosticsUseCase,
    private readonly getNodeRunInput: GetWorkflowNodeRunInputUseCase,
    private readonly getStepHealth: GetWorkflowStepHealthUseCase,
    private readonly listStepRuns: ListWorkflowStepRunsUseCase,
  ) {}

  @Get('runs/:runId/variables')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getVariables(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowRunParamsSchema.parse(params);
    return this.getRunVariables.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
    });
  }

  @Get('runs/:runId/input')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AutomationAuthenticationGuard, WorkflowRunDataReadGuard)
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
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AutomationAuthenticationGuard, WorkflowRunDataReadGuard)
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
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(AutomationAuthenticationGuard, WorkflowRunDataReadGuard)
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

  @Get('runs/:runId/node-runs/:nodeRunId/diagnostics')
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async getDiagnostics(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
  ) {
    const route = workflowNodeRunParamsSchema.parse(params);
    return this.getNodeRunDiagnostics.execute({
      actor: actorFrom(request, route.workspaceId),
      routeWorkspaceId: route.workspaceId,
      ...optionalAuthorizedWorkspace(request),
      runId: route.runId,
      nodeRunId: route.nodeRunId,
    });
  }

  @Get('workflows/:workflowId/step-health')
  @Header('Cache-Control', 'private, no-store')
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
  @Header('Cache-Control', 'private, no-store')
  @UseGuards(SessionAuthenticationGuard, WorkflowRunReadGuard)
  public async listWorkflowStepRuns(
    @Req() request: WorkflowRunsRequest,
    @Param() params: unknown,
    @Query() query: unknown,
  ) {
    const route = workflowStepRunsParamsSchema.parse(params);
    const { limit } = parseRequestInput(workflowStepRunsQuerySchema, query);
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
