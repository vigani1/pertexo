import type {
  AudienceReview,
  FolderSharingRequest,
  SharingPrincipalsQuery,
  WorkflowMoveReviewRequest,
} from '@pertexo/contracts';
import type { workflowFolders } from '@pertexo/database/schema';
import type { OrganizationRequestScope } from '../session.js';

export type Command = OrganizationRequestScope &
  Readonly<{ idempotencyKey: string }>;

type FolderCommand = Command &
  Readonly<{ folderId: string; expectedFolderRevision: number }>;

// Depth and creation permission come from the hierarchy and actor's grants.
export type WorkflowFolderRecord = Readonly<
  Pick<
    typeof workflowFolders.$inferSelect,
    'id' | 'name' | 'parentId' | 'revision' | 'accessMode'
  > & { depth: number; canCreateWorkflows?: boolean }
>;

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

export type SharingPrincipalsInput = OrganizationRequestScope & {
  query: SharingPrincipalsQuery;
};
export type ReadFolderSharingInput = OrganizationRequestScope & {
  folderId: string;
};
export type ReplaceFolderSharingInput = Command & {
  folderId: string;
  request: FolderSharingRequest;
};
export type ReviewMoveInput = OrganizationRequestScope & {
  request: WorkflowMoveReviewRequest;
};
export type CreateFolderInput = Command &
  Readonly<{ name: string; parentId: string | null }>;
export type RenameFolderInput = FolderCommand & Readonly<{ name: string }>;
export type MoveFolderInput = FolderCommand &
  Readonly<{
    parentId: string | null;
    audienceReview?: AudienceReview | undefined;
  }>;
export type DeleteFolderInput = FolderCommand;
export type PlaceWorkflowInput = Command &
  Readonly<{
    workflowId: string;
    folderId: string | null;
    expectedOrganizationRevision: number;
    audienceReview?: AudienceReview | undefined;
  }>;
