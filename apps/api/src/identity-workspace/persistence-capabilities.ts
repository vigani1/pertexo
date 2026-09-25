import type {
  IdentityWorkspacePersistence,
  InvitationTokenProtector,
} from './ports.js';

/*
 * Optional identity-workspace capabilities narrowed to the required ports the
 * use cases depend on. An unconfigured capability fails closed when used
 * instead of failing module registration.
 */

export const missingInvitationTokenProtector: InvitationTokenProtector =
  Object.freeze({
    seal: () => {
      throw new Error('Invitation token protection is not configured');
    },
  });

type InvitationPersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'listWorkspaceInvitations'
    | 'createWorkspaceInvitation'
    | 'resendWorkspaceInvitation'
    | 'revokeWorkspaceInvitation'
  >
>;
type RenamePersistence = Required<
  Pick<IdentityWorkspacePersistence, 'renameWorkspace'>
>;

export function renamePersistence(
  persistence: IdentityWorkspacePersistence,
): RenamePersistence {
  return persistence.renameWorkspace === undefined
    ? missingRenamePersistence
    : Object.freeze({
        renameWorkspace: persistence.renameWorkspace.bind(persistence),
      });
}

const missingRenamePersistence: RenamePersistence = Object.freeze({
  renameWorkspace: () =>
    Promise.reject(new Error('Workspace rename persistence is not configured')),
});

type MemberRemovalPersistence = Required<
  Pick<IdentityWorkspacePersistence, 'removeWorkspaceMember'>
>;

export function memberRemovalPersistence(
  persistence: IdentityWorkspacePersistence,
): MemberRemovalPersistence {
  return persistence.removeWorkspaceMember === undefined
    ? missingMemberRemovalPersistence
    : Object.freeze({
        removeWorkspaceMember:
          persistence.removeWorkspaceMember.bind(persistence),
      });
}

const missingMemberRemovalPersistence: MemberRemovalPersistence = Object.freeze(
  {
    removeWorkspaceMember: () =>
      Promise.reject(
        new Error('Workspace member removal persistence is not configured'),
      ),
  },
);

type ProfilePersistence = Required<
  Pick<IdentityWorkspacePersistence, 'updateUserProfile'>
>;

export function profilePersistence(
  persistence: IdentityWorkspacePersistence,
): ProfilePersistence {
  return persistence.updateUserProfile === undefined
    ? missingProfilePersistence
    : Object.freeze({
        updateUserProfile: persistence.updateUserProfile.bind(persistence),
      });
}

const missingProfilePersistence: ProfilePersistence = Object.freeze({
  updateUserProfile: () =>
    Promise.reject(new Error('User profile persistence is not configured')),
});

type AcceptancePersistence = Required<
  Pick<
    IdentityWorkspacePersistence,
    | 'resolveInvitationAcceptance'
    | 'readInvitationAcceptance'
    | 'recordInvitationAcceptanceProof'
    | 'completeInvitationAcceptance'
    | 'abandonInvitationAcceptance'
  >
>;

export function invitationPersistence(
  persistence: IdentityWorkspacePersistence,
): InvitationPersistence {
  if (
    persistence.listWorkspaceInvitations === undefined ||
    persistence.createWorkspaceInvitation === undefined ||
    persistence.resendWorkspaceInvitation === undefined ||
    persistence.revokeWorkspaceInvitation === undefined
  )
    return missingInvitationPersistence;
  return Object.freeze({
    listWorkspaceInvitations:
      persistence.listWorkspaceInvitations.bind(persistence),
    createWorkspaceInvitation:
      persistence.createWorkspaceInvitation.bind(persistence),
    resendWorkspaceInvitation:
      persistence.resendWorkspaceInvitation.bind(persistence),
    revokeWorkspaceInvitation:
      persistence.revokeWorkspaceInvitation.bind(persistence),
  });
}

const missingInvitationPersistence: InvitationPersistence = Object.freeze({
  listWorkspaceInvitations: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  createWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  resendWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
  revokeWorkspaceInvitation: () =>
    Promise.reject(new Error('Invitation persistence is not configured')),
});

export function acceptancePersistence(
  persistence: IdentityWorkspacePersistence,
): AcceptancePersistence {
  if (
    persistence.resolveInvitationAcceptance === undefined ||
    persistence.readInvitationAcceptance === undefined ||
    persistence.recordInvitationAcceptanceProof === undefined ||
    persistence.completeInvitationAcceptance === undefined ||
    persistence.abandonInvitationAcceptance === undefined
  )
    return missingAcceptancePersistence;
  return Object.freeze({
    resolveInvitationAcceptance:
      persistence.resolveInvitationAcceptance.bind(persistence),
    readInvitationAcceptance:
      persistence.readInvitationAcceptance.bind(persistence),
    recordInvitationAcceptanceProof:
      persistence.recordInvitationAcceptanceProof.bind(persistence),
    completeInvitationAcceptance:
      persistence.completeInvitationAcceptance.bind(persistence),
    abandonInvitationAcceptance:
      persistence.abandonInvitationAcceptance.bind(persistence),
  });
}

const missingAcceptancePersistence: AcceptancePersistence = Object.freeze({
  resolveInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  readInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  recordInvitationAcceptanceProof: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  completeInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
  abandonInvitationAcceptance: () =>
    Promise.reject(
      new Error('Invitation acceptance persistence is not configured'),
    ),
});
