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
    const workspaceId = workspaceIdOf(routeParams(request));
    return Object.freeze({
      workspaceId,
      ...projectAuthenticatedWorkspaceContext(request, workspaceId),
    });
  },
);

/** What an API service takes: the actor, the route's workspace and the guard's proof. */
export function serviceCaller({ workspaceId, ...context }: WorkspaceCaller) {
  return { ...context, routeWorkspaceId: workspaceId };
}

/** What a core store takes: the workspace, the actor and the token a command runs under. */
export function storeCaller(caller: WorkspaceCaller) {
  return storeContext(serviceCaller(caller));
}

/** The request's identifiers, which core records on commands. */
export function requestIdentifiers({
  requestId,
  traceId,
}: Readonly<{ requestId: string; traceId?: string | undefined }>): Readonly<{
  requestId: string;
  traceId?: string;
}> {
  return traceId === undefined ? { requestId } : { requestId, traceId };
}

/** What a service hands a core store, from the caller `serviceCaller` gave it. */
export function storeContext({
  routeWorkspaceId,
  actor,
}: Readonly<{ routeWorkspaceId: string; actor: ActorContext }>) {
  return {
    workspaceId: routeWorkspaceId,
    actorId: actor.actorId,
    ...commandCredential(actor),
  };
}

/** A core command's context from a service: the store's context and the request's identifiers. */
export function commandContext(
  input: Readonly<{ routeWorkspaceId: string; actor: ActorContext }>,
) {
  return { ...storeContext(input), ...requestIdentifiers(input.actor) };
}

function workspaceIdOf(params: unknown): string {
  return (params as Readonly<{ workspaceId: string }>).workspaceId;
}
