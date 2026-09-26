import {
  workflowNodeRunOutputResponseSchema,
  workflowRunInputResponseSchema,
  type WorkflowNodeRunOutputResponse,
  type WorkflowRunInputResponse,
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
