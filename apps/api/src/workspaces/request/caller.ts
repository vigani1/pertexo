import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type {
  ActorContext,
  AuthorizedWorkspaceContext,
} from '../../authorization/index.js';
import { commandCredential } from '../../authorization/credentials.js';
import { routeParams } from '../../platform/http/route.js';
import type { IdentityWorkspaceRequest } from '../workspace-transport.js';
import { projectAuthenticatedWorkspaceContext } from './authenticated-context.js';

/** Who calls a workspace route, as its guards proved it. */
export type WorkspaceCaller = Readonly<{
  workspaceId: string;
  actor: ActorContext;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  requestId: string;
  traceId?: string;
}>;

/**
 * The caller of a workspace route, projected once from the route's parsed
 * `workspaceId`. A handler takes it with `@Caller()` and hands core what it
 * needs through `serviceCaller` or `storeCaller`.
 */
export const Caller = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WorkspaceCaller => {
    const request = context
      .switchToHttp()
      .getRequest<IdentityWorkspaceRequest & object>();
    return workspaceCaller(request, workspaceIdOf(routeParams(request)));
  },
);

/** The caller of a route in `workspaceId`; `@Caller()` is the usual way in. */
export function workspaceCaller(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
): WorkspaceCaller {
  return Object.freeze({
    workspaceId,
    ...projectAuthenticatedWorkspaceContext(request, workspaceId),
  });
}

/** What an API service takes: the actor, the route's workspace and the guard's proof. */
export function serviceCaller({ workspaceId, ...context }: WorkspaceCaller) {
  return { ...context, routeWorkspaceId: workspaceId };
}

/** What a core store takes: the workspace, the actor and the token a command runs under. */
export function storeCaller({ workspaceId, actor }: WorkspaceCaller) {
  return { workspaceId, actorId: actor.actorId, ...commandCredential(actor) };
}

/** The request's identifiers, which core records on commands. */
export function requestIdentifiers({
  requestId,
  traceId,
}: WorkspaceCaller): Readonly<{ requestId: string; traceId?: string }> {
  return traceId === undefined ? { requestId } : { requestId, traceId };
}

function workspaceIdOf(params: unknown): string {
  return (params as Readonly<{ workspaceId: string }>).workspaceId;
}
