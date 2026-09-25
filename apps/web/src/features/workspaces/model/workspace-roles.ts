import type {
  AccessibleWorkspace,
  WorkspaceMember,
} from '@pertexo/contracts/schemas/identity-workspace';

export type WorkspaceRole = AccessibleWorkspace['role'];
export type ManagedRole = Exclude<WorkspaceRole, 'owner'>;
type Capability = AccessibleWorkspace['capabilities'][number];

export const WORKSPACE_ROLES = [
  'owner',
  'admin',
  'builder',
  'operator',
  'viewer',
] as const satisfies readonly WorkspaceRole[];

export const ROLE_NAMES: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  operator: 'Operator',
  viewer: 'Viewer',
};

/** Whole words that fit a phone-width roles matrix column. */
export const ROLE_SHORT_NAMES: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Build',
  operator: 'Ops',
  viewer: 'View',
};

/** One line per role, for pickers: what someone with it can do. */
export const ROLE_SUMMARIES: Readonly<Record<WorkspaceRole, string>> = {
  owner:
    'Everything, including renaming, deleting and handing over the workspace.',
  admin: 'Everything except renaming, deleting or handing over the workspace.',
  builder: 'Builds, tests and publishes workflows, and starts runs.',
  operator: 'Starts, cancels and replays runs, without changing workflows.',
  viewer: 'Sees workflows, runs and connections, and changes nothing.',
};

/**
 * The roles matrix, in words. Mirrors `workspace-policy.ts` in
 * packages/database: a role has a row when it holds every listed capability.
 * A test pins this table to that policy.
 */
export const ROLE_MATRIX: readonly Readonly<{
  ability: string;
  capabilities: readonly Capability[];
  roles: readonly WorkspaceRole[];
}>[] = [
  {
    ability: 'See workflows, runs and connections',
    capabilities: [
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
      'artifact:read',
    ],
    roles: ['owner', 'admin', 'builder', 'operator', 'viewer'],
  },
  {
    ability: 'Start runs',
    capabilities: ['run:start'],
    roles: ['owner', 'admin', 'builder', 'operator'],
  },
  {
    ability: 'Cancel and replay runs',
    capabilities: ['run:cancel', 'run:replay'],
    roles: ['owner', 'admin', 'operator'],
  },
  {
    ability: 'Build, test and publish workflows',
    capabilities: ['workflow:create', 'workflow:update', 'workflow:publish'],
    roles: ['owner', 'admin', 'builder'],
  },
  {
    ability: 'Manage connections',
    capabilities: ['connection:manage'],
    roles: ['owner', 'admin'],
  },
  {
    ability: 'Manage members and invitations',
    capabilities: ['member:manage'],
    roles: ['owner', 'admin'],
  },
  {
    ability: 'Rename, delete or hand over the workspace',
    capabilities: ['workspace:manage'],
    roles: ['owner'],
  },
];

// Capabilities the matrix doesn't draw as a row of their own.
const UNLISTED_CAPABILITY_ROLES: Readonly<
  Partial<Record<Capability, readonly WorkspaceRole[]>>
> = {
  'artifact:upload': ['owner', 'admin', 'builder', 'operator'],
  'connection:use': ['owner', 'admin', 'builder', 'operator'],
  'member:read': ['owner', 'admin'],
};

/** The roles that hold a capability, most powerful first like the matrix. */
export function rolesAllowedTo(
  capability: Capability,
): readonly WorkspaceRole[] {
  const row = ROLE_MATRIX.find((candidate) =>
    candidate.capabilities.includes(capability),
  );
  return row?.roles ?? UNLISTED_CAPABILITY_ROLES[capability] ?? ['owner'];
}

const ROLE_PLURALS: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'owners',
  admin: 'admins',
  builder: 'builders',
  operator: 'operators',
  viewer: 'viewers',
};

/**
 * A forbidden state in words: the person's role, what it can't do and who
 * can, e.g. "Your role (Operator) can’t manage connections. Admins and
 * owners can."
 */
export function roleLimitSentence(
  role: WorkspaceRole,
  capability: Capability,
  action: string,
): string {
  const allowed = [...rolesAllowedTo(capability)]
    .filter((candidate) => candidate !== role)
    .reverse()
    .map((candidate) => ROLE_PLURALS[candidate]);
  const last = allowed.pop() ?? 'owners';
  const who = allowed.length === 0 ? last : `${allowed.join(', ')} and ${last}`;
  return `Your role (${ROLE_NAMES[role]}) can’t ${action}. ${who.charAt(0).toUpperCase()}${who.slice(1)} can.`;
}

const DELEGATED_ROLES = [
  'builder',
  'operator',
  'viewer',
] as const satisfies readonly ManagedRole[];

/** Roles this person may give others, by invitation or role change. */
export function assignableRoles(
  actorRole: WorkspaceRole,
): readonly ManagedRole[] {
  if (actorRole === 'owner') return ['admin', ...DELEGATED_ROLES];
  if (actorRole === 'admin') return DELEGATED_ROLES;
  return [];
}

/**
 * Whom this person may manage, for presentation only (ADR 037 and ADR 042):
 * not yourself, never the owner; owners manage anyone else, admins only
 * builders, operators and viewers. The server stays authoritative.
 */
export function canRemoveMember(
  actor: Readonly<{ role: WorkspaceRole; userId: string }>,
  member: WorkspaceMember,
): boolean {
  if (member.userId === actor.userId || member.role === 'owner') return false;
  if (actor.role === 'owner') return true;
  return (
    actor.role === 'admin' &&
    DELEGATED_ROLES.some((role) => role === member.role)
  );
}

/** Role changes also need an active membership. */
export function canChangeRoleOf(
  actor: Readonly<{ role: WorkspaceRole; userId: string }>,
  member: WorkspaceMember,
): boolean {
  return member.membershipStatus === 'active' && canRemoveMember(actor, member);
}

/** Suspension and reactivation follow the removal rules (ADR 047). */
export function canSuspendMember(
  actor: Readonly<{ role: WorkspaceRole; userId: string }>,
  member: WorkspaceMember,
): boolean {
  return canRemoveMember(actor, member);
}

/** Only the owner hands over the workspace, to another active member. */
export function canTransferOwnershipTo(
  actor: Readonly<{ role: WorkspaceRole; userId: string }>,
  member: WorkspaceMember,
): boolean {
  return (
    actor.role === 'owner' &&
    member.role !== 'owner' &&
    member.userId !== actor.userId &&
    member.membershipStatus === 'active'
  );
}

/** Everyone but the owner may leave; the owner hands the workspace over first. */
export function canLeaveWorkspace(role: WorkspaceRole): boolean {
  return role !== 'owner';
}

/** How confirmations address a member: their first name, or "They". */
export function firstNameOf(member: WorkspaceMember | undefined): string {
  return member?.displayName.split(/\s+/u)[0] ?? 'They';
}

/** "an Admin", "a Builder". */
export function withArticle(role: WorkspaceRole): string {
  const name = ROLE_NAMES[role];
  return /^[AEIOU]/u.test(name) ? `an ${name}` : `a ${name}`;
}
