import type {
  SharingPrincipalsQuery,
  SharingPrincipals,
} from '@pertexo/contracts';
import type {
  AudienceReview,
  FolderSharing,
  FolderSharingRequest,
  WorkflowMoveReviewRequest,
  WorkflowMoveReview,
} from '@pertexo/contracts';
import type { OrganizationRequestScope } from '../session.js';

export type Command = OrganizationRequestScope &
  Readonly<{ idempotencyKey: string }>;

type FolderCommand = Command &
  Readonly<{ folderId: string; expectedFolderRevision: number }>;

export type WorkflowFolderRecord = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  revision: number;
  depth: number;
  accessMode: 'workspace' | 'restricted';
  canCreateWorkflows?: boolean;
}>;

export type WorkflowFolderCommandResult = Readonly<{
  folder: WorkflowFolderRecord;
  replayed: boolean;
}>;

export type WorkflowFolderDeleteResult = Readonly<{
  folderId: string;
  deleted: true;
  replayed: boolean;
}>;

export type WorkflowFolderPlacementResult = Readonly<{
  workflowId: string;
  folderId: string | null;
  organizationRevision: number;
  replayed: boolean;
}>;

export interface WorkflowFolderDatabase {
  sharingPrincipals(
    input: OrganizationRequestScope & { query: SharingPrincipalsQuery },
  ): Promise<SharingPrincipals>;
  readSharing(
    input: OrganizationRequestScope & { folderId: string },
  ): Promise<FolderSharing>;
  replaceSharing(
    input: Command & { folderId: string; request: FolderSharingRequest },
  ): Promise<FolderSharing & { replayed: boolean }>;
  reviewMove(
    input: OrganizationRequestScope & { request: WorkflowMoveReviewRequest },
  ): Promise<WorkflowMoveReview>;
  listFolders(
    input: OrganizationRequestScope,
  ): Promise<Readonly<{ items: readonly WorkflowFolderRecord[] }>>;
  createFolder(
    input: Command & Readonly<{ name: string; parentId: string | null }>,
  ): Promise<WorkflowFolderCommandResult>;
  renameFolder(
    input: FolderCommand & Readonly<{ name: string }>,
  ): Promise<WorkflowFolderCommandResult>;
  moveFolder(
    input: FolderCommand &
      Readonly<{
        parentId: string | null;
        audienceReview?: AudienceReview | undefined;
      }>,
  ): Promise<WorkflowFolderCommandResult>;
  deleteFolder(input: FolderCommand): Promise<WorkflowFolderDeleteResult>;
  placeWorkflow(
    input: Command &
      Readonly<{
        workflowId: string;
        folderId: string | null;
        expectedOrganizationRevision: number;
        audienceReview?: AudienceReview | undefined;
      }>,
  ): Promise<WorkflowFolderPlacementResult>;
  close(): Promise<void>;
}
