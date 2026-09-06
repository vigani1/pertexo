import {
  AUTHORIZATION_CAPABILITIES,
  ROLES,
  type AuthorizationCapability,
  type Role,
} from '@pertexo/database/api';

export { AUTHORIZATION_CAPABILITIES, ROLES };
export type { AuthorizationCapability };

export const MEMBERSHIP_STATUSES = Object.freeze([
  'active',
  'suspended',
  'removed',
] as const);

export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const WORKSPACE_STATUSES = Object.freeze([
  'active',
  'suspended',
  'pending_deletion',
  'purging',
  'deleted',
] as const);

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export type WorkspaceId = string;

export type ActorContext = Readonly<{
  actorId: string;
  kind: 'user';
  workspaceId: WorkspaceId;
  sessionId: string;
  requestId: string;
  traceId?: string;
}>;

export type WorkspaceAccess = Readonly<{
  actorId: string;
  workspaceId: WorkspaceId;
  role: Role;
  membershipStatus: MembershipStatus;
  workspaceStatus: WorkspaceStatus;
}>;

export type DisclosurePolicy = 'forbidden' | 'not_found';

export type AuthorizedWorkspaceContext = Readonly<{
  actor: ActorContext;
  workspaceId: WorkspaceId;
  role: Role;
  capability: AuthorizationCapability;
}>;
