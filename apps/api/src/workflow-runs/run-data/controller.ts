import { Controller, Req, UseInterceptors } from '@nestjs/common';
import {
  workflowRunDataRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../workspaces/http/route.js';
import { caller, type WorkflowRunsRequest } from '../http/request-context.js';
import {
  GetWorkflowNodeRunInputUseCase,
  GetWorkflowNodeRunDiagnosticsUseCase,
  GetWorkflowNodeRunOutputUseCase,
  GetWorkflowRunInputUseCase,
  GetWorkflowRunVariablesUseCase,
  GetWorkflowStepHealthUseCase,
  ListWorkflowStepRunsUseCase,
} from './run-data.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize.js';

/**
 * A run's input and each step's output (ADR 050), and each step across its
 * workflow's recent runs (ADR 051). All of it can hold sensitive data, so the
 * routes tell browsers and proxies to keep no copy.
 */
@UseInterceptors(domainErrors(runFailure))
@Controller()
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

  @Route(routes.variables)
  public getVariables(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.variables>,
  ) {
    return this.getRunVariables.execute({
      ...caller(request, params),
      runId: params.runId,
    });
  }

  @Route(routes.input)
  public getInput(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.input>,
  ) {
    return this.getRunInput.execute({
      ...caller(request, params),
      runId: params.runId,
    });
  }

  @Route(routes.nodeOutput)
  public getOutput(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.nodeOutput>,
  ) {
    return this.getNodeRunOutput.execute({
      ...caller(request, params),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.nodeInput)
  public getNodeInput(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.nodeInput>,
  ) {
    return this.getNodeRunInput.execute({
      ...caller(request, params),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.diagnostics)
  public getDiagnostics(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.diagnostics>,
  ) {
    return this.getNodeRunDiagnostics.execute({
      ...caller(request, params),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.stepHealth)
  public getWorkflowStepHealth(
    @Req() request: WorkflowRunsRequest,
    @In() { params }: RouteInput<typeof routes.stepHealth>,
  ) {
    return this.getStepHealth.execute({
      ...caller(request, params),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.stepRuns)
  public listWorkflowStepRuns(
    @Req() request: WorkflowRunsRequest,
    @In() { params, query }: RouteInput<typeof routes.stepRuns>,
  ) {
    return this.listStepRuns.execute({
      ...caller(request, params),
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }
}
