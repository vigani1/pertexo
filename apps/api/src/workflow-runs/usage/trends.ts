import {
  usageTrendsResponseSchema,
  type UsageTrendPeriod,
  type UsageTrendsResponse,
} from '@pertexo/contracts';
import {
  authorizeWorkspaceOperation,
  hasCapability,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from '../ports.js';

export class GetUsageTrendsUseCase {
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
      allowedWorkspaceStatuses: ['active', 'suspended', 'pending_deletion'],
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return usageTrendsResponseSchema.parse(
      await this.persistence.usageTrends({
        actorId: input.actor.actorId,
        workspaceId: input.routeWorkspaceId,
        period: input.period,
        includeWorkflowNames: hasCapability(access.role, 'workflow:read'),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
  }
}
