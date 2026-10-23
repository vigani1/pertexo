import { utf8ByteLength } from '@pertexo/workflow-model';

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

import { FOLDER_DEPTH_LIMIT } from '../limits.js';

import { z } from 'zod';

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

export const uuid = z.uuid().overwrite((value) => value.toLowerCase());

export const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const canonicalName = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) =>
      value === value.replace(/^ +| +$(?![\s\S])/gu, '') &&
      utf8ByteLength(value) >= 1 &&
      utf8ByteLength(value) <= 128 &&
      !Array.from(value).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
  );

export const name = z
  .string()
  .overwrite((value) => value.replace(/^ +| +$(?![\s\S])/gu, ''))
  .pipe(canonicalName);

export const folder = z
  .object({
    id: uuid,
    name: canonicalName,
    parentId: uuid.nullable(),
    revision,
    depth: z.number().int().min(1).max(FOLDER_DEPTH_LIMIT),
    accessMode: z.enum(['workspace', 'restricted']),
  })
  .strict()
  .refine((value) =>
    value.parentId === null ? value.depth === 1 : value.depth > 1,
  );

export const folderResult = z.object({ folder }).strict();

export const deleteResult = z
  .object({ folderId: uuid, deleted: z.literal(true) })
  .strict();

export const placementResult = z
  .object({
    workflowId: uuid,
    folderId: uuid.nullable(),
    organizationRevision: revision,
  })
  .strict();

/** Sibling names are unique regardless of ASCII letter case. */
export const nameKey = (value: string): string =>
  value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
