import {
  usageCapacityResponseSchema,
  type UsageCapacityResponse,
} from '@pertexo/contracts';

import {
  authorizeWorkspaceCapabilities,
  type WorkspaceAuthorizationSource,
} from '../../authorization/index.js';
import type {
  WorkflowRunApplicationInput,
  WorkflowRunPersistence,
} from '../ports.js';

/** Current operational capacity, never a billing or retained-activity meter. */
export class GetUsageCapacityUseCase {
  public constructor(
    private readonly persistence: Pick<WorkflowRunPersistence, 'usageCapacity'>,
    private readonly authorization: WorkspaceAuthorizationSource,
  ) {}

  public async execute(
    input: WorkflowRunApplicationInput & Readonly<{ signal?: AbortSignal }>,
  ): Promise<UsageCapacityResponse> {
    await authorizeWorkspaceCapabilities({
      actor: input.actor,
      routeWorkspaceId: input.routeWorkspaceId,
      capabilities: ['run:read', 'artifact:read'],
      access: this.authorization,
      disclosure: 'not_found',
      allowedWorkspaceStatuses: ['active'],
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.authorizedWorkspace === undefined
        ? {}
        : { authorizedWorkspace: input.authorizedWorkspace }),
    });
    return usageCapacityResponseSchema.parse(
      await this.persistence.usageCapacity({
        workspaceId: input.routeWorkspaceId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }),
    );
  }
}
