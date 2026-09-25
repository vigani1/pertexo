import {
  workflowRunStatisticsResponseSchema,
  type WorkflowRunStatisticsResponse,
} from '@pertexo/contracts/workflow-runs';

import {
  authorizeWorkspaceOperation,
  hasCapability,
  type AuthorizationCapability,
  type AuthorizedWorkspaceContext,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
  WorkflowRunStatisticsWindow,
} from './ports.js';

export type GetWorkflowRunStatisticsInput = WorkflowRunApplicationInput &
  Readonly<{
    window?: WorkflowRunStatisticsWindow;
    breakdown?: 'workflow';
  }>;

/**
 * Exact run counts for one workspace snapshot (ADR 044). Readers of the run
 * list may read its counts; workflow names follow `workflow:read`, as on the
 * list itself.
 */
export class GetWorkflowRunStatisticsUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'statistics'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly capabilityPolicy: (
      role: AuthorizedWorkspaceContext['role'],
      capability: AuthorizationCapability,
    ) => boolean = hasCapability,
  ) {}

  public async execute(
    input: GetWorkflowRunStatisticsInput,
  ): Promise<WorkflowRunStatisticsResponse> {
    const access = await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'run:read',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
    const statistics = await this.persistence.statistics({
      workspaceId: input.routeWorkspaceId,
      window: input.window ?? '24h',
      includeWorkflows: input.breakdown === 'workflow',
      includeWorkflowName: this.capabilityPolicy(access.role, 'workflow:read'),
    });
    return workflowRunStatisticsResponseSchema.parse({
      ...statistics,
      workflows: statistics.workflows ?? null,
    });
  }
}
