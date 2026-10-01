import {
  usageCapacityResponseSchema,
  type UsageCapacityResponse,
} from '@pertexo/contracts/workflow-runs';

import {
  authorizeWorkspaceOperation,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from './ports.js';

/** Current operational capacity, never a billing or retained-activity meter. */
export class GetUsageCapacityUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'usageCapacity'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: WorkflowRunApplicationInput & Readonly<{ signal?: AbortSignal }>,
  ): Promise<UsageCapacityResponse> {
    for (const capability of ['run:read', 'artifact:read'] as const) {
      await authorizeWorkspaceOperation({
        actor: input.actor,
        routeWorkspaceId: input.routeWorkspaceId,
        capability,
        access: this.authorization,
        disclosure: 'not_found',
        allowedWorkspaceStatuses: ['active'],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.authorizedWorkspace?.capability !== capability
          ? {}
          : { authorizedWorkspace: input.authorizedWorkspace }),
      });
    }
    return usageCapacityResponseSchema.parse(
      await this.persistence.usageCapacity({
        workspaceId: input.routeWorkspaceId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
  }
}
