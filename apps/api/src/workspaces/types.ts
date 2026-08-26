export const ROLES = Object.freeze([
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
] as const);

export type Role = (typeof ROLES)[number];

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

export const AUTHORIZATION_CAPABILITIES = Object.freeze([
  'workspace:read',
  'workspace:manage',
  'workflow:read',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:read',
  'run:start',
  'run:cancel',
  'run:replay',
  'connection:read',
  'connection:use',
  'connection:manage',
  'member:read',
  'member:manage',
] as const);

export type AuthorizationCapability =
  (typeof AUTHORIZATION_CAPABILITIES)[number];

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
