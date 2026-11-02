import type {
  IdentityWorkspaceStore,
  WorkspaceInvitationRecord,
  CreateWorkspaceInvitationInput,
  InvitationAcceptanceIntentRecord,
  ResolveInvitationAcceptanceInput,
  InvitationAcceptanceResult,
  UserRecord,
  WorkspaceMemberRecord,
  WorkspaceRenameResult,
  SealedInvitationToken as StoredInvitationToken,
} from '@pertexo/core/tenant-access';

import type {
  IdentityClock,
  IdentityCrypto,
  AuthenticatedSession,
  SessionCookieBoundary,
  SignInEvidence,
  SessionIssueInput,
  SessionIssueResult,
} from '../identity/index.js';
import type {
  WorkspaceAccessQuery,
  WorkspaceAuthorizationSource,
} from '../authorization/index.js';
import type { WorkspaceAccess } from '../authorization/index.js';
import type { IdentityWorkspaceTelemetry } from './telemetry.js';

export type IdentityWorkspaceConfig = Readonly<{
  publicWebOrigin: string;
  session?: Readonly<{
    ttlMillis?: number;
    secureCookie?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
  }>;
}>;

/** Optional commands keep test fakes narrow; persisted shapes have one owner. */
export type IdentityWorkspacePersistence = Pick<
  IdentityWorkspaceStore,
  | 'findUserById'
  | 'listWorkspaceMembers'
  | 'changeWorkspaceMemberRole'
  | 'listAccessibleWorkspaces'
> &
  Partial<
    Pick<
      IdentityWorkspaceStore,
      | 'removeWorkspaceMember'
      | 'leaveWorkspace'
      | 'suspendWorkspaceMember'
      | 'reactivateWorkspaceMember'
      | 'transferWorkspaceOwnership'
      | 'updateUserProfile'
      | 'listWorkspaceInvitations'
      | 'createWorkspaceInvitation'
      | 'resendWorkspaceInvitation'
      | 'revokeWorkspaceInvitation'
      | 'resolveInvitationAcceptance'
      | 'readInvitationAcceptance'
      | 'recordInvitationAcceptanceProof'
      | 'completeInvitationAcceptance'
      | 'abandonInvitationAcceptance'
    >
  > &
  Readonly<{
    createWorkspaceWithOwner(
      input: Parameters<
        IdentityWorkspaceStore['createWorkspaceWithOwner']
      >[0] & { idempotencyKey: string },
    ): Promise<WorkspacePersistenceRecord>;
    renameWorkspace?(
      input: Parameters<IdentityWorkspaceStore['renameWorkspace']>[0],
    ): Promise<WorkspaceRenamePersistenceResult>;
    requestWorkspaceLifecycleOperation(
      input: Parameters<
        IdentityWorkspaceStore['requestWorkspaceLifecycleOperation']
      >[0],
    ): Promise<WorkspaceLifecycleOperationRecord>;
  }>;

export type WorkspaceInvitationPersistenceRecord = WorkspaceInvitationRecord;
export type SealedInvitationToken = StoredInvitationToken;

export type WorkspaceInvitationCreatePersistenceInput =
  CreateWorkspaceInvitationInput;
export type InvitationAcceptanceIntentPersistenceRecord =
  InvitationAcceptanceIntentRecord;
export type InvitationAcceptanceResolvePersistenceInput =
  ResolveInvitationAcceptanceInput;
export type InvitationAcceptancePersistenceResult = InvitationAcceptanceResult;

export interface InvitationTokenProtector {
  seal(
    plaintext: string,
    associatedData: string,
  ): Promise<SealedInvitationToken> | SealedInvitationToken;
}

export type UserProfilePersistenceRecord = UserRecord;

export type WorkspaceMemberPersistenceRecord = WorkspaceMemberRecord;

export type WorkspacePersistenceRecord = Pick<
  Awaited<ReturnType<IdentityWorkspaceStore['createWorkspaceWithOwner']>>,
  'id' | 'name' | 'slug' | 'status' | 'revision' | 'createdAt' | 'updatedAt'
>;
export type WorkspaceRenamePersistenceResult = Omit<
  WorkspaceRenameResult,
  'workspace'
> &
  Readonly<{ workspace: WorkspacePersistenceRecord }>;

/** The receipt of a lifecycle request, applied when submitted. */
export type WorkspaceLifecycleOperationRecord = Pick<
  Awaited<
    ReturnType<IdentityWorkspaceStore['requestWorkspaceLifecycleOperation']>
  >,
  'id' | 'workspaceId' | 'commandType' | 'submittedAt'
>;

export interface WorkspaceAuthorizationReader {
  findAccess(query: WorkspaceAccessQuery): Promise<WorkspaceAccess | undefined>;
}

export interface IdentitySessionAuthority {
  issue(
    input: SessionIssueInput,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult>;
  authenticate(
    cookieValue: string,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<AuthenticatedSession>;
  revoke(cookieValue: string): Promise<void>;
  /** Writes the cookies of a session another transaction installed. */
  deliver(
    token: string,
    cookieBoundary: SessionCookieBoundary,
  ): Promise<SessionIssueResult>;
  /**
   * The verified identity behind a browser session and when its credential
   * was last presented; invitation acceptance uses it as fresh recipient
   * evidence.
   */
  signInEvidence(cookieValue: string): Promise<SignInEvidence>;
}

export type IdentityWorkspaceDependencies = Readonly<{
  config: IdentityWorkspaceConfig;
  persistence: IdentityWorkspacePersistence;
  authorization: WorkspaceAuthorizationSource;
  crypto?: IdentityCrypto;
  clock?: IdentityClock;
  telemetry?: IdentityWorkspaceTelemetry;
  invitationTokens?: InvitationTokenProtector;
  sessions: IdentitySessionAuthority;
}>;

export type { WorkspaceAuthorizationSource } from '../authorization/index.js';

export type SessionCookiePolicy = Readonly<{
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
}>;
