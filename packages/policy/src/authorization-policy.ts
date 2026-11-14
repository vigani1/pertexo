/** Workspace grants shared by authoring, storage, the API and browser presentation. */
export const ROLES = Object.freeze([
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
] as const);
export type Role = (typeof ROLES)[number];

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
  // Run data follows the run; apart from run:read only so a token can go without it.
  'run:read-data': ROLES,
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

/** Capabilities that may be delegated to a workspace API token. */
export const API_TOKEN_SCOPES = [
  'workflow:read',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:read',
  'run:read-data',
  'run:start',
  'run:cancel',
  'connection:read',
  'workspace:read',
  'variable:manage',
] as const satisfies readonly AuthorizationCapability[];
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
