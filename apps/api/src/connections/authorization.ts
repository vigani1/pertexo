import {
  authorizeWorkspace,
  authorizeWorkspaceOperation,
  type ActorContext,
  type AuthorizedWorkspaceContext,
  type WorkspaceAuthorizationSource,
} from '../workspaces/index.js';

export type ConnectionAuthorizationInput = Readonly<{
  actor: ActorContext;
  routeWorkspaceId: string;
  authorizedWorkspace?: AuthorizedWorkspaceContext;
}>;

export async function authorizeConnectionOperation(
  input: ConnectionAuthorizationInput,
  access: WorkspaceAuthorizationSource,
  capability: 'connection:manage' | 'connection:use' = 'connection:manage',
): Promise<void> {
  await authorizeWorkspaceOperation({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability,
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
    ...(input.authorizedWorkspace === undefined
      ? {}
      : { authorizedWorkspace: input.authorizedWorkspace }),
  });
}

export async function reauthorizeConnectionSecretAccess(
  input: ConnectionAuthorizationInput,
  access: WorkspaceAuthorizationSource,
): Promise<void> {
  // Credential egress is a second security boundary after the durable test
  // intent is created. Re-read membership here so revocation during that gap
  // prevents secret decryption and provider dispatch.
  await authorizeWorkspace({
    actor: input.actor,
    routeWorkspaceId: input.routeWorkspaceId,
    capability: 'connection:use',
    access,
    disclosure: 'not_found',
    allowedWorkspaceStatuses: ['active'],
  });
}
