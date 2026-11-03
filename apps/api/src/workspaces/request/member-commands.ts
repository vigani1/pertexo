import type { WorkspaceMemberCommandInput } from '../members/role.js';
import { projectAuthenticatedWorkspaceContext } from './authenticated-context.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';

type MemberRouteInput<Request> = Readonly<{
  params: Readonly<{ workspaceId: string; userId?: string }>;
  body: Request;
  idempotencyKey: string;
}>;

/**
 * The authorized actor, target and exact delivery of a member command. Without a
 * member in the path, the actor is the target, as when leaving.
 */
export function memberCommand<Request>(
  request: IdentityWorkspaceRequest,
  { params, body, idempotencyKey }: MemberRouteInput<Request>,
): WorkspaceMemberCommandInput<Request> {
  const { actor } = projectAuthenticatedWorkspaceContext(
    request,
    params.workspaceId,
  );
  return {
    actor,
    routeWorkspaceId: params.workspaceId,
    targetUserId: params.userId ?? actor.actorId,
    request: body,
    idempotencyKey,
    requestId: actor.requestId,
    ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
  };
}
