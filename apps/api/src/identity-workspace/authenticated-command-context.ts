import {
  createActorContext,
  type ActorContext,
  type AuthorizedWorkspaceContext,
} from '../workspaces/index.js';
import { authenticatedSession } from './guards.js';
import { requestIdentifier, traceIdentifier } from './request-identifiers.js';
import type { IdentityWorkspaceRequest } from './types.js';
import { InvalidAuthenticatedWorkspaceContextError } from './authenticated-command-context-error.js';

export function authenticatedRequestIdentifiers(
  request: IdentityWorkspaceRequest,
): Readonly<{ requestId: string; traceId?: string }> {
  const actor = request.authorizedWorkspace?.actor;
  if (actor !== undefined)
    return {
      requestId: actor.requestId,
      ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
    };
  const traceId = traceIdentifier(request);
  return {
    requestId: requestIdentifier(request),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

export function optionalAuthorizedWorkspace(
  request: IdentityWorkspaceRequest,
): Readonly<{ authorizedWorkspace?: AuthorizedWorkspaceContext }> {
  return request.authorizedWorkspace === undefined
    ? {}
    : { authorizedWorkspace: request.authorizedWorkspace };
}

/** Project the common successful identity/workspace command context. */
export function projectAuthenticatedWorkspaceContext(
  request: IdentityWorkspaceRequest,
  workspaceId: string,
): Readonly<{
  actor: ActorContext;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
  requestId: string;
  traceId?: string;
}> {
  const authorizedWorkspace = request.authorizedWorkspace;
  const identifiers = authenticatedRequestIdentifiers(request);
  let actor = authorizedWorkspace?.actor;
  if (actor === undefined) {
    try {
      const session = authenticatedSession(request);
      actor = createActorContext({
        actorId: session.userId,
        workspaceId,
        sessionId: session.sessionId,
        ...identifiers,
      });
    } catch (error) {
      throw new InvalidAuthenticatedWorkspaceContextError(
        error instanceof Error ? error.message : 'Invalid actor context',
        { cause: error },
      );
    }
  }
  return Object.freeze({
    actor,
    ...optionalAuthorizedWorkspace(request),
    requestId: actor.requestId,
    ...(actor.traceId === undefined ? {} : { traceId: actor.traceId }),
  });
}
