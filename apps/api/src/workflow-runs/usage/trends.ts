import type { UsageTrendPeriod, UsageTrendsResponse } from '@pertexo/contracts';
import {
  authorizeWorkspaceOperation,
  hasCapability,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from '../ports.js';
import { UNPURGED_WORKSPACE_STATUSES } from '@pertexo/policy';

export class GetUsageTrendsService {
  constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'usageTrends'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}
  async execute(
    input: WorkflowRunApplicationInput &
      Readonly<{ period: UsageTrendPeriod; signal?: AbortSignal }>,
  ): Promise<UsageTrendsResponse> {
    const access = await authorizeWorkspaceOperation({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capability: 'run:read',
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: UNPURGED_WORKSPACE_STATUSES,
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return await this.persistence.usageTrends({
      actorId: input.actor.actorId,
      workspaceId: input.routeWorkspaceId,
      period: input.period,
      includeWorkflowNames: hasCapability(access.role, 'workflow:read'),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
}
