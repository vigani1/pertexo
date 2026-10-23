import { workspaceIdentifierSchema } from '@pertexo/contracts';
import { authenticatedSession } from '../../../workspaces/index.js';
import type { IdentityWorkspaceRequest } from '../../../workspaces/types.js';
import { requestIdempotencyKey } from '../../../platform/http/idempotency-key.js';
import {
  withRequestOperationSignal,
  type AbortableRequest,
} from '../../../platform/http/request-operation-signal.js';

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
  workspace: unknown,
): FederationScope {
  return {
    workspaceId: workspaceIdentifierSchema.parse(workspace),
    actorId: authenticatedSession(request).userId,
  };
}
export function federationCommand<T>(
  request: FederationManagementRequest,
  workspace: unknown,
  work: (scope: FederationCommandScope) => Promise<T>,
): Promise<T> {
  const scope = federationScope(request, workspace);
  const idempotencyKey = requestIdempotencyKey(request.headers);
  return withRequestOperationSignal(request, (signal) =>
    work({ ...scope, idempotencyKey, signal }),
  );
}
