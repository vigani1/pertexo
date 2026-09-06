/**
 * The platform-owned workspace authorization policy.
 *
 * This module is deliberately free of database, HTTP, and framework imports so
 * persistence and API authorization can evaluate the same role/capability
 * mapping without depending on one another.
 */

export const ROLES = Object.freeze([
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
] as const);

export type Role = (typeof ROLES)[number];

export const AUTHORIZATION_CAPABILITIES = Object.freeze([
  'workspace:read',
  'workspace:manage',
  'artifact:read',
  'artifact:upload',
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

const readCapabilities = Object.freeze([
  'artifact:read',
  'workspace:read',
  'workflow:read',
  'run:read',
  'connection:read',
] as const satisfies readonly AuthorizationCapability[]);

const ownerCapabilities = Object.freeze([
  ...AUTHORIZATION_CAPABILITIES,
] as const satisfies readonly AuthorizationCapability[]);

const adminCapabilities = Object.freeze([
  ...readCapabilities,
  'artifact:upload',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:start',
  'run:cancel',
  'run:replay',
  'connection:use',
  'connection:manage',
  'member:read',
  'member:manage',
] as const satisfies readonly AuthorizationCapability[]);

const builderCapabilities = Object.freeze([
  ...readCapabilities,
  'artifact:upload',
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:start',
  'connection:use',
] as const satisfies readonly AuthorizationCapability[]);

const operatorCapabilities = Object.freeze([
  ...readCapabilities,
  'artifact:upload',
  'run:start',
  'run:cancel',
  'run:replay',
  'connection:use',
] as const satisfies readonly AuthorizationCapability[]);

const roleCapabilities: Readonly<
  Record<Role, readonly AuthorizationCapability[]>
> = Object.freeze({
  owner: ownerCapabilities,
  admin: adminCapabilities,
  builder: builderCapabilities,
  operator: operatorCapabilities,
  viewer: readCapabilities,
});

export function hasCapability(
  role: Role,
  capability: AuthorizationCapability,
): boolean {
  return roleCapabilities[role].includes(capability);
}

export function capabilitiesForRole(
  role: Role,
): readonly AuthorizationCapability[] {
  return roleCapabilities[role];
}

export function rolesForCapability(
  capability: AuthorizationCapability,
): readonly Role[] {
  return Object.freeze(ROLES.filter((role) => hasCapability(role, capability)));
}
