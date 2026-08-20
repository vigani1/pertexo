import {
  AUTHORIZATION_CAPABILITIES,
  type AuthorizationCapability,
  type Role,
} from './types.js';

const readCapabilities = Object.freeze([
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
  'workflow:create',
  'workflow:update',
  'workflow:publish',
  'run:start',
  'connection:use',
] as const satisfies readonly AuthorizationCapability[]);

const operatorCapabilities = Object.freeze([
  ...readCapabilities,
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

export const WORKSPACE_ROLE_CAPABILITIES = roleCapabilities;

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
