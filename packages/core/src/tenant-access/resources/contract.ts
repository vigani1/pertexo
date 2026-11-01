import type { WorkspaceTransaction } from '@pertexo/database/primitives';
import type { AuthorizationCapability, Role } from '@pertexo/workflow-model';

export type ResourceActor = Readonly<{
  workspaceId: string;
  actorId: string;
}>;
export type WorkflowResourceCapability = Extract<
  AuthorizationCapability,
  `workflow:${string}` | `run:${string}`
>;
export type FolderAccess = 'viewer' | 'editor';
export type FolderFact = Readonly<{
  id: string;
  parentId: string | null;
  accessMode: 'workspace' | 'restricted';
}>;
/** Only grants matching this actor's current member/group identities enter the policy. */
export type MatchingFolderGrant = Readonly<{
  folderId: string;
  access: FolderAccess;
}>;
export type FolderScope = Readonly<{
  workspaceId: string;
  role: Role | null;
  readFolderIds: readonly string[];
  editFolderIds: readonly string[];
  permits(
    folderId: string | null,
    capability: WorkflowResourceCapability,
  ): boolean;
  deniedFolderIds(capability: WorkflowResourceCapability): readonly string[];
  restrictions(folderId: string | null): readonly string[];
}>;

export type ResourceTransaction = WorkspaceTransaction &
  Readonly<{ resources: FolderScope }>;
