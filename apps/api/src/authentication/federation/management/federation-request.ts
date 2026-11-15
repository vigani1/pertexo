import {
  withRequestOperationSignal,
  type AbortableRequest,
} from '../../../platform/http/request-operation-signal.js';
import type { IdentityWorkspaceRequest } from '../../../workspaces/workspace-transport.js';
import {
  storeCaller,
  type WorkspaceCaller,
} from '../../../workspaces/request/caller.js';

export type FederationManagementRequest = IdentityWorkspaceRequest &
  AbortableRequest;
export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
}>;
export type FederationCommandScope = FederationScope &
  Readonly<{ idempotencyKey: string; signal: AbortSignal }>;

export function federationCommand<T>(
  request: FederationManagementRequest,
  caller: WorkspaceCaller,
  { idempotencyKey }: Readonly<{ idempotencyKey: string }>,
  work: (scope: FederationCommandScope) => Promise<T>,
): Promise<T> {
  const scope = storeCaller(caller);
  return withRequestOperationSignal(request, (signal) =>
    work({ ...scope, idempotencyKey, signal }),
  );
}
