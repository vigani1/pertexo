import {
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowRunInputResponseSchema,
  workflowStepHealthResponseSchema,
  workflowStepRunsResponseSchema,
  type WorkflowNodeRunInputResponse,
  type WorkflowNodeRunOutputResponse,
  type WorkflowRunInputResponse,
  type WorkflowStepHealthResponse,
  type WorkflowStepRunsResponse,
} from '@pertexo/contracts/workflow-runs';

import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from './ports.js';
import { WorkflowRunNotFoundError } from './use-cases.js';

export type GetWorkflowRunInputInput = WorkflowRunApplicationInput &
  Readonly<{ runId: string }>;

export type GetWorkflowNodeRunOutputInput = GetWorkflowRunInputInput &
  Readonly<{ nodeRunId: string }>;

/** Run data follows the run: whoever can open it can read it (ADR 050). */
async function authorizeRunData(
  input: WorkflowRunApplicationInput,
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: 'run:read',
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}

/** The input a run started with, as stored. */
export class GetWorkflowRunInputUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'readInput'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: GetWorkflowRunInputInput,
  ): Promise<WorkflowRunInputResponse> {
    await authorizeRunData(input, this.authorization);
    const data = await this.persistence.readInput({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
    });
    if (data === undefined) throw new WorkflowRunNotFoundError();
    return workflowRunInputResponseSchema.parse({ input: data });
  }
}

/** One node run's current output, only through the run it belongs to. */
export class GetWorkflowNodeRunOutputUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowRunPersistence,
      'readNodeRunOutput'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: GetWorkflowNodeRunOutputInput,
  ): Promise<WorkflowNodeRunOutputResponse> {
    await authorizeRunData(input, this.authorization);
    const data = await this.persistence.readNodeRunOutput({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      nodeRunId: input.nodeRunId,
    });
    if (data === undefined) throw new WorkflowRunNotFoundError();
    return workflowNodeRunOutputResponseSchema.parse({ output: data });
  }
}

/** What one node run received, when it was recorded (ADR 052). */
export class GetWorkflowNodeRunInputUseCase {
  public constructor(
    private readonly persistence: Pick<
      WorkflowRunPersistence,
      'readNodeRunInput'
    >,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: GetWorkflowNodeRunOutputInput,
  ): Promise<WorkflowNodeRunInputResponse> {
    await authorizeRunData(input, this.authorization);
    const data = await this.persistence.readNodeRunInput({
      workspaceId: input.routeWorkspaceId,
      runId: input.runId,
      nodeRunId: input.nodeRunId,
    });
    if (data === undefined) throw new WorkflowRunNotFoundError();
    return workflowNodeRunInputResponseSchema.parse({ input: data });
  }
}

export type GetWorkflowStepHealthInput = WorkflowRunApplicationInput &
  Readonly<{ workflowId: string }>;

export type ListWorkflowStepRunsInput = GetWorkflowStepHealthInput &
  Readonly<{ nodeId: string; limit?: number }>;

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** Each step across the workflow's last 100 runs (ADR 051). */
export class GetWorkflowStepHealthUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'stepHealth'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: GetWorkflowStepHealthInput,
  ): Promise<WorkflowStepHealthResponse> {
    await authorizeRunData(input, this.authorization);
    const page = await this.persistence.stepHealth({
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
    });
    if (page === undefined) throw new WorkflowRunNotFoundError();
    return workflowStepHealthResponseSchema.parse({
      runsConsidered: page.runsConsidered,
      oldestRunAt: iso(page.oldestRunAt),
      items: page.items.map((item) => ({
        ...item,
        lastRanAt: item.lastRanAt.toISOString(),
      })),
    });
  }
}

/** One step's runs in the workflow's last 100 runs, newest first. */
export class ListWorkflowStepRunsUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'stepRuns'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: ListWorkflowStepRunsInput,
  ): Promise<WorkflowStepRunsResponse> {
    await authorizeRunData(input, this.authorization);
    const items = await this.persistence.stepRuns({
      workspaceId: input.routeWorkspaceId,
      workflowId: input.workflowId,
      nodeId: input.nodeId,
      limit: input.limit ?? 20,
    });
    if (items === undefined) throw new WorkflowRunNotFoundError();
    return workflowStepRunsResponseSchema.parse({
      items: items.map((item) => ({
        ...item,
        runCreatedAt: item.runCreatedAt.toISOString(),
        startedAt: iso(item.startedAt),
        completedAt: iso(item.completedAt),
      })),
    });
  }
}
