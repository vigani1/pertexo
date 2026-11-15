import { ADMINISTRATIVE_ROLES, type Role } from '@pertexo/policy';

// The words for roles, kept apart from the role matrix so the always-loaded
// shell can name administrators without loading the matrix.

export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  operator: 'Operator',
  viewer: 'Viewer',
};

const ROLE_PLURALS: Readonly<Record<Role, string>> = {
  owner: 'owners',
  admin: 'admins',
  builder: 'builders',
  operator: 'operators',
  viewer: 'viewers',
};

/** Roles as a plural list: "owners, admins and builders". */
export function listRoles(roles: readonly Role[]): string {
  const names = roles.map((role) => ROLE_PLURALS[role]);
  const last = names.pop() ?? 'owners';
  return names.length === 0 ? last : `${names.join(', ')} and ${last}`;
}

/** Who the administrative rules name, such as who always keeps shared access. */
export const ADMINISTRATORS = listRoles(ADMINISTRATIVE_ROLES);

/** Any one of them, after an article: "an owner or admin". */
export const ANY_ADMINISTRATOR = ADMINISTRATIVE_ROLES.map((role) =>
  ROLE_NAMES[role].toLowerCase(),
).join(' or ');
