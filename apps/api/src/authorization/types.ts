import type { IdentityWorkspaceDatabase } from '@pertexo/database/tenant-access';
import type { ApiTokenScope } from '@pertexo/contracts';
import {
  AUTHORIZATION_CAPABILITIES,
  BROWSABLE_WORKSPACE_STATUSES,
  ROLES,
  UNPURGED_WORKSPACE_STATUSES,
  type AuthorizationCapability,
  type Role,
} from '@pertexo/workflow-model';

export {
  AUTHORIZATION_CAPABILITIES,
  BROWSABLE_WORKSPACE_STATUSES,
  ROLES,
  UNPURGED_WORKSPACE_STATUSES,
};
export type { AuthorizationCapability };

export const MEMBERSHIP_STATUSES = Object.freeze([
  'active',
  'suspended',
  'removed',
] as const);

export const WORKSPACE_STATUSES = Object.freeze([
  'active',
  'suspended',
  'pending_deletion',
  'purging',
  'deleted',
] as const);

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export type WorkspaceId = string;

type ActorIdentity = Readonly<{
  actorId: string;
  workspaceId: WorkspaceId;
  requestId: string;
  traceId?: string;
}>;
export type UserActorContext = ActorIdentity &
  Readonly<{ kind: 'user'; sessionId: string }>;
export type ApiTokenActorContext = ActorIdentity &
  Readonly<{
    kind: 'api_key';
    tokenId: string;
    scopes: readonly ApiTokenScope[];
  }>;
export type ActorContext = UserActorContext | ApiTokenActorContext;

export type WorkspaceAccess = NonNullable<
  Awaited<ReturnType<IdentityWorkspaceDatabase['findWorkspaceAccess']>>
>;

export type DisclosurePolicy = 'forbidden' | 'not_found';

export type AuthorizedWorkspaceContext = Readonly<{
  actor: ActorContext;
  workspaceId: WorkspaceId;
  role: Role;
  capability: AuthorizationCapability;
}>;
