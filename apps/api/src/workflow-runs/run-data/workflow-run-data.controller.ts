import { Controller, UseInterceptors } from '@nestjs/common';
import {
  workflowRunDataRoutes as routes,
  type RouteInput,
} from '@pertexo/contracts/server';

import { In, Route } from '../../platform/http/route.js';
import {
  GetWorkflowNodeRunInputService,
  GetWorkflowNodeRunDiagnosticsService,
  GetWorkflowNodeRunOutputService,
  GetWorkflowRunInputService,
  GetWorkflowRunVariablesService,
  GetWorkflowStepHealthService,
  ListWorkflowStepRunsService,
} from './run-data.service.js';
import { domainErrors } from '../../platform/http/problems/interceptor.js';
import { runFailure } from '../../problems/context/normalize-context-errors.js';
import {
  Caller,
  serviceCaller,
  type WorkspaceCaller,
} from '../../workspaces/request/caller.js';

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
    private readonly getRunInput: GetWorkflowRunInputService,
    private readonly getRunVariables: GetWorkflowRunVariablesService,
    private readonly getNodeRunOutput: GetWorkflowNodeRunOutputService,
    private readonly getNodeRunDiagnostics: GetWorkflowNodeRunDiagnosticsService,
    private readonly getNodeRunInput: GetWorkflowNodeRunInputService,
    private readonly getStepHealth: GetWorkflowStepHealthService,
    private readonly listStepRuns: ListWorkflowStepRunsService,
  ) {}

  @Route(routes.variables)
  public getVariables(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.variables>,
  ) {
    return this.getRunVariables.execute({
      ...serviceCaller(caller),
      runId: params.runId,
    });
  }

  @Route(routes.input)
  public getInput(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.input>,
  ) {
    return this.getRunInput.execute({
      ...serviceCaller(caller),
      runId: params.runId,
    });
  }

  @Route(routes.nodeOutput)
  public getOutput(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.nodeOutput>,
  ) {
    return this.getNodeRunOutput.execute({
      ...serviceCaller(caller),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.nodeInput)
  public getNodeInput(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.nodeInput>,
  ) {
    return this.getNodeRunInput.execute({
      ...serviceCaller(caller),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.diagnostics)
  public getDiagnostics(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.diagnostics>,
  ) {
    return this.getNodeRunDiagnostics.execute({
      ...serviceCaller(caller),
      runId: params.runId,
      nodeRunId: params.nodeRunId,
    });
  }

  @Route(routes.stepHealth)
  public getWorkflowStepHealth(
    @Caller() caller: WorkspaceCaller,
    @In() { params }: RouteInput<typeof routes.stepHealth>,
  ) {
    return this.getStepHealth.execute({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
    });
  }

  @Route(routes.stepRuns)
  public listWorkflowStepRuns(
    @Caller() caller: WorkspaceCaller,
    @In() { params, query }: RouteInput<typeof routes.stepRuns>,
  ) {
    return this.listStepRuns.execute({
      ...serviceCaller(caller),
      workflowId: params.workflowId,
      nodeId: params.nodeId,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  }
}
