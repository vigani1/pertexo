import type { WorkspaceMemberCommandInput } from '../members/role.js';
import { projectAuthenticatedWorkspaceContext } from './authenticated-context.js';
import { requestIdempotencyKey } from '../../platform/http/index.js';
import {
  workspaceIdParamSchema,
  workspaceMemberRoleParamsSchema,
  type IdentityWorkspaceRequest,
} from '../types.js';

/** The authorized actor, target and exact delivery of a member command. */
export function memberCommand(
  request: IdentityWorkspaceRequest,
  params: unknown,
  body: unknown,
): WorkspaceMemberCommandInput {
  const { workspaceId, userId } = workspaceMemberRoleParamsSchema.parse(params);
  return memberCommandFor(request, workspaceId, userId, body);
}

/** A member command the actor issues about themselves, e.g. leaving. */
export function selfCommand(
  request: IdentityWorkspaceRequest,
  params: unknown,
  body: unknown,
): WorkspaceMemberCommandInput {
  const { workspaceId } = workspaceIdParamSchema.parse(params);
  return memberCommandFor(request, workspaceId, undefined, body);
}

function memberCommandFor(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
  targetUserId: string | undefined,
  body: unknown,
): WorkspaceMemberCommandInput {
  const actor = projectAuthenticatedWorkspaceContext(
    request,
    workspaceId,
  ).actor;
  return {
    actor,
    routeWorkspaceId: workspaceId,
    targetUserId: targetUserId ?? actor.actorId,
    request: body,
    idempotencyKey: requestIdempotencyKey(request.headers),
    requestId: actor.requestId,
    ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
  };
}
