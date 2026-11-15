import {
  authorizeWorkspaceOperation,
  hasCapability,
  type AuthorizationCapability,
  type AuthorizedWorkspaceContext,
  type WorkspaceAuthorizationSource,
} from '../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
  WorkflowRunStatisticsWindow,
} from './ports.js';

const DEFAULT_STATISTICS_WINDOW = '24h';

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
export class GetWorkflowRunStatisticsService {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'statistics'>,
    private readonly authorization: WorkspaceAuthorizationSource,
    private readonly capabilityPolicy: (
      role: AuthorizedWorkspaceContext['role'],
      capability: AuthorizationCapability,
    ) => boolean = hasCapability,
  ) {}

  public async execute(input: GetWorkflowRunStatisticsInput) {
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
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      window: input.window ?? DEFAULT_STATISTICS_WINDOW,
      includeWorkflows: input.breakdown === 'workflow',
      includeWorkflowName: this.capabilityPolicy(access.role, 'workflow:read'),
    });
    return {
      ...statistics,
      workflows: statistics.workflows ?? null,
    };
  }
}
