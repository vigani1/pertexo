import {
  withRequestOperationSignal,
  type AbortableRequest,
} from '../../../platform/http/request-operation-signal.js';
import { authenticatedSession } from '../../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../../workspaces/types.js';

export type FederationManagementRequest = IdentityWorkspaceRequest &
  AbortableRequest;
export type FederationScope = Readonly<{
  workspaceId: string;
  actorId: string;
}>;
export type FederationCommandScope = FederationScope &
  Readonly<{ idempotencyKey: string; signal: AbortSignal }>;

export function federationScope(
  request: FederationManagementRequest,
  workspaceId: string,
): FederationScope {
  return {
    workspaceId,
    actorId: authenticatedSession(request).userId,
  };
}
export function federationCommand<T>(
  request: FederationManagementRequest,
  input: Readonly<{ workspaceId: string; idempotencyKey: string }>,
  work: (scope: FederationCommandScope) => Promise<T>,
): Promise<T> {
  const scope = federationScope(request, input.workspaceId);
  const { idempotencyKey } = input;
  return withRequestOperationSignal(request, (signal) =>
    work({ ...scope, idempotencyKey, signal }),
  );
}
