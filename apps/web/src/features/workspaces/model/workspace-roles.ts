import { sentenceStart } from '@/lib/format/sentence';
import {
  ADMINISTRATIVE_ROLES,
  ROLES,
  hasCapability,
  rolesForCapability as rolesAllowedTo,
  canInviteWorkspaceRole,
  canRemoveWorkspaceMember,
  canTransferWorkspaceOwnership,
  type Role,
  type DelegatedRole,
  type AuthorizationCapability,
} from '@pertexo/workflow-model';
export { rolesAllowedTo, ROLES as WORKSPACE_ROLES };
export { canLeaveWorkspace } from '@pertexo/workflow-model';
import type { WorkspaceMember } from '@pertexo/contracts';

export type WorkspaceRole = Role;
export type ManagedRole = DelegatedRole;
type Capability = AuthorizationCapability;

export const ROLE_NAMES: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  operator: 'Operator',
  viewer: 'Viewer',
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

/** Presentation rows select capabilities; the shared policy supplies their roles. */
type RoleAbility = Readonly<{
  ability: string;
  capabilities: readonly Capability[];
}>;
const roleAbilities: readonly RoleAbility[] = [
  {
    ability: 'See workflows, runs and connections',
    capabilities: [
      'workspace:read',
      'workflow:read',
      'run:read',
      'connection:read',
      'artifact:read',
    ],
  },
  {
    ability: 'Start runs',
    capabilities: ['run:start'],
  },
  {
    ability: 'Cancel and replay runs',
    capabilities: ['run:cancel', 'run:replay'],
  },
  {
    ability: 'Manage notification email defaults',
    capabilities: ['notification:manage_defaults'],
  },
  {
    ability: 'Get operational notices by default',
    capabilities: ['notification:read'],
  },
  {
    ability: 'Build, test and publish workflows',
    capabilities: ['workflow:create', 'workflow:update', 'workflow:publish'],
  },
  {
    ability: 'Read the audit log and manage audit retention',
    capabilities: ['audit:read', 'governance:manage'],
  },
  {
    ability: 'Manage workspace variables',
    capabilities: ['variable:manage'],
  },
  {
    ability: 'Manage connections',
    capabilities: ['connection:manage'],
  },
  {
    ability: 'Manage members and invitations',
    capabilities: ['member:manage'],
  },
  {
    ability: 'Rename, delete or hand over the workspace',
    capabilities: ['workspace:manage'],
  },
];

export const ROLE_MATRIX: readonly (RoleAbility &
  Readonly<{ roles: readonly WorkspaceRole[] }>)[] = roleAbilities.map(
  (row) => ({
    ...row,
    roles: ROLES.filter((role) =>
      row.capabilities.every((capability) => hasCapability(role, capability)),
    ),
  }),
);

const ROLE_PLURALS: Readonly<Record<WorkspaceRole, string>> = {
  owner: 'owners',
  admin: 'admins',
  builder: 'builders',
  operator: 'operators',
  viewer: 'viewers',
};

function listRoles(roles: readonly WorkspaceRole[]): string {
  const names = roles.map((role) => ROLE_PLURALS[role]);
  const last = names.pop() ?? 'owners';
  return names.length === 0 ? last : `${names.join(', ')} and ${last}`;
}

/** Who holds a capability, as the policy grants it: "owners and admins". */
export function whoCan(capability: Capability): string {
  return listRoles(rolesAllowedTo(capability));
}

/** Who the administrative rules name, such as who always keeps shared access. */
export const ADMINISTRATORS = listRoles(ADMINISTRATIVE_ROLES);

/** The end of a refusal, nearest role first: "Admins and owners can." */
export function refusalWhoCan(
  capability: Capability,
  role?: WorkspaceRole,
): string {
  const others = rolesAllowedTo(capability).filter(
    (candidate) => candidate !== role,
  );
  return `${sentenceStart(listRoles([...others].reverse()))} can.`;
}

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
  return `Your role (${ROLE_NAMES[role]}) can’t ${action}. ${refusalWhoCan(capability, role)}`;
}

/** Roles this person may give others, by invitation or role change. */
export function assignableRoles(
  actorRole: WorkspaceRole,
): readonly ManagedRole[] {
  return ROLES.filter(
    (role): role is ManagedRole =>
      role !== 'owner' && canInviteWorkspaceRole(actorRole, role),
  );
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
  const otherManualMember =
    member.directorySource === undefined && member.userId !== actor.userId;
  return otherManualMember && canRemoveWorkspaceMember(actor.role, member.role);
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
  const eligibleTarget =
    member.directorySource === undefined &&
    member.userId !== actor.userId &&
    member.membershipStatus === 'active';
  return (
    eligibleTarget && canTransferWorkspaceOwnership(actor.role, member.role)
  );
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
