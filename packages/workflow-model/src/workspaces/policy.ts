/** Workspace grants shared by authoring, storage, the API and browser presentation. */
export const ROLES = Object.freeze([
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
] as const);
export type Role = (typeof ROLES)[number];

/** A change needs an active workspace. */
export const ACTIVE_WORKSPACE_STATUSES = Object.freeze(['active'] as const);
/** A suspended workspace reads but does not change (ADR 013/027). */
export const BROWSABLE_WORKSPACE_STATUSES = Object.freeze([
  'active',
  'suspended',
] as const);
/**
 * A workspace scheduled for deletion can still be restored, and its owner opens
 * it to decide. Reads using this list stay open until the purge starts.
 */
export const UNPURGED_WORKSPACE_STATUSES = Object.freeze([
  ...BROWSABLE_WORKSPACE_STATUSES,
  'pending_deletion',
] as const);
/** A rule names the list it means, so two with different values can't be mistaken. */
export type WorkspaceStatusList =
  | typeof ACTIVE_WORKSPACE_STATUSES
  | typeof BROWSABLE_WORKSPACE_STATUSES
  | typeof UNPURGED_WORKSPACE_STATUSES;
export const DELEGATED_ROLES = Object.freeze(
  ROLES.filter((role) => role !== 'owner'),
);
export type DelegatedRole = (typeof DELEGATED_ROLES)[number];

export const ADMINISTRATIVE_ROLES = Object.freeze([
  'owner',
  'admin',
] as const satisfies readonly Role[]);
export type AdministrativeRole = (typeof ADMINISTRATIVE_ROLES)[number];
export function isAdministrativeRole(role: Role): role is AdministrativeRole {
  return ADMINISTRATIVE_ROLES.some((candidate) => candidate === role);
}

export const WORKFLOW_EDITOR_ROLES = Object.freeze([
  ...ADMINISTRATIVE_ROLES,
  'builder',
] as const satisfies readonly Role[]);
const operationalRoles = Object.freeze([
  ...ADMINISTRATIVE_ROLES,
  'operator',
] as const satisfies readonly Role[]);
const executionRoles = Object.freeze([
  ...WORKFLOW_EDITOR_ROLES,
  'operator',
] as const satisfies readonly Role[]);
const ownerRole = Object.freeze(['owner'] as const satisfies readonly Role[]);

/** The only capability-to-roles grant decisions. Other views derive from this table. */
const capabilityRoles = Object.freeze({
  'workspace:read': ROLES,
  'workspace:manage': ownerRole,
  'audit:read': ADMINISTRATIVE_ROLES,
  'governance:manage': ADMINISTRATIVE_ROLES,
  'variable:manage': ADMINISTRATIVE_ROLES,
  'artifact:read': ROLES,
  'artifact:upload': executionRoles,
  'workflow:read': ROLES,
  'workflow:create': WORKFLOW_EDITOR_ROLES,
  'workflow:update': WORKFLOW_EDITOR_ROLES,
  'workflow:publish': WORKFLOW_EDITOR_ROLES,
  'run:read': ROLES,
  'run:start': executionRoles,
  'run:cancel': operationalRoles,
  'run:replay': operationalRoles,
  'connection:read': ROLES,
  'connection:use': executionRoles,
  'connection:manage': ADMINISTRATIVE_ROLES,
  'member:read': ADMINISTRATIVE_ROLES,
  'member:manage': ADMINISTRATIVE_ROLES,
  'notification:read': operationalRoles,
  'notification:manage_defaults': ADMINISTRATIVE_ROLES,
} satisfies Readonly<Record<string, readonly Role[]>>);
export type AuthorizationCapability = keyof typeof capabilityRoles;
export const AUTHORIZATION_CAPABILITIES = Object.freeze(
  Object.keys(capabilityRoles) as AuthorizationCapability[],
);

export function hasCapability(
  role: Role,
  capability: AuthorizationCapability,
): boolean {
  const permitted: readonly Role[] = capabilityRoles[capability];
  return permitted.includes(role);
}
export function rolesForCapability(
  capability: AuthorizationCapability,
): readonly Role[] {
  return capabilityRoles[capability];
}

// Preserve the published capability presentation order independently of grants.
const memberCapabilityOrder = Object.freeze([
  ...new Set<AuthorizationCapability>([
    'audit:read',
    'governance:manage',
    'variable:manage',
    'artifact:read',
    'workspace:read',
    'workflow:read',
    'run:read',
    'connection:read',
    ...AUTHORIZATION_CAPABILITIES,
  ]),
]);
function orderedCapabilities(
  role: Role,
  order: readonly AuthorizationCapability[],
): readonly AuthorizationCapability[] {
  return Object.freeze(
    order.filter((capability) => hasCapability(role, capability)),
  );
}
const roleCapabilities = Object.freeze({
  owner: orderedCapabilities('owner', AUTHORIZATION_CAPABILITIES),
  admin: orderedCapabilities('admin', memberCapabilityOrder),
  builder: orderedCapabilities('builder', memberCapabilityOrder),
  operator: orderedCapabilities('operator', memberCapabilityOrder),
  viewer: orderedCapabilities('viewer', memberCapabilityOrder),
} satisfies Readonly<Record<Role, readonly AuthorizationCapability[]>>);
export function capabilitiesForRole(
  role: Role,
): readonly AuthorizationCapability[] {
  return roleCapabilities[role];
}

const administratorManagedRoles = DELEGATED_ROLES.filter(
  (role) => role !== 'admin',
);

/** ADR 037 role-transition policy, shared by UI projection and the database command. */
export function canChangeWorkspaceMemberRole(
  actorRole: Role,
  targetRole: Role,
  nextRole: Role,
): boolean {
  if (nextRole === 'owner' || targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === targetRole) &&
    administratorManagedRoles.some((role) => role === nextRole)
  );
}

/**
 * ADR 042 removal policy: owners remove any non-owner member, admins remove
 * only builder, operator or viewer members. Self-removal is decided by the
 * caller, which knows both identities.
 */
export function canRemoveWorkspaceMember(
  actorRole: Role,
  targetRole: Role,
): boolean {
  if (targetRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === targetRole)
  );
}

/**
 * ADR 047 suspension policy, for suspending and reactivating: the removal
 * matrix. Self-suspension is decided by the caller.
 */
export function canSuspendWorkspaceMember(
  actorRole: Role,
  targetRole: Role,
): boolean {
  return canRemoveWorkspaceMember(actorRole, targetRole);
}

/** ADR 047: only the owner hands the workspace to another member. */
export function canTransferWorkspaceOwnership(
  actorRole: Role,
  targetRole: Role,
): boolean {
  return actorRole === 'owner' && targetRole !== 'owner';
}

/** ADR 047: every member except the owner may leave. */
export function canLeaveWorkspace(role: Role): boolean {
  return role !== 'owner';
}

/** ADR 038 invitation policy. Current database state remains authoritative. */
export function canInviteWorkspaceRole(
  actorRole: Role,
  invitedRole: Role,
): boolean {
  if (invitedRole === 'owner') return false;
  if (actorRole === 'owner') return true;
  return (
    actorRole === 'admin' &&
    administratorManagedRoles.some((role) => role === invitedRole)
  );
}
