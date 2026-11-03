import type { IdentityWorkspacePersistence } from '../../src/workspaces/ports.js';

/** Module-composition tests supply a complete port, even for commands they never call. */
export function unusedWorkspacePersistence(): IdentityWorkspacePersistence {
  const notExercised = (): Promise<never> =>
    Promise.reject(
      new Error('Workspace persistence was not exercised by this fixture'),
    );
  return {
    findUserById: notExercised,
    listAccessibleWorkspaces: notExercised,
    listWorkspaceMembers: notExercised,
    changeWorkspaceMemberRole: notExercised,
    removeWorkspaceMember: notExercised,
    leaveWorkspace: notExercised,
    suspendWorkspaceMember: notExercised,
    reactivateWorkspaceMember: notExercised,
    transferWorkspaceOwnership: notExercised,
    updateUserProfile: notExercised,
    listWorkspaceInvitations: notExercised,
    createWorkspaceInvitation: notExercised,
    resendWorkspaceInvitation: notExercised,
    revokeWorkspaceInvitation: notExercised,
    resolveInvitationAcceptance: notExercised,
    readInvitationAcceptance: notExercised,
    recordInvitationAcceptanceProof: notExercised,
    completeInvitationAcceptance: notExercised,
    abandonInvitationAcceptance: notExercised,
    createWorkspaceWithOwner: notExercised,
    renameWorkspace: notExercised,
    requestWorkspaceLifecycleOperation: notExercised,
  };
}
