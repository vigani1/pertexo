import { z } from 'zod';

import type { OrganizationRequestScope } from '../session.js';

export type Command = OrganizationRequestScope &
  Readonly<{ idempotencyKey: string }>;

export type PageInput = OrganizationRequestScope &
  Readonly<{ limit?: number; afterId?: string }>;

type TaggedCommand = Command &
  Readonly<{ tagId: string; expectedTagRevision: number }>;

export type AssignmentCommand = Command &
  Readonly<{ workflowId: string; expectedOrganizationRevision: number }>;

export type WorkflowTagRecord = Readonly<{
  id: string;
  key: string;
  revision: number;
}>;

export type WorkflowTagAssignment = Readonly<{
  workflowId: string;
  organizationRevision: number;
}>;

export type Page<T> = Readonly<{ items: readonly T[]; nextId: string | null }>;

export type WorkflowTagCommandResult = Readonly<{
  tag: WorkflowTagRecord;
  replayed: boolean;
}>;

export type WorkflowTagDeleteResult = Readonly<{
  tagId: string;
  deleted: true;
  detachedWorkflowCount: number;
  replayed: boolean;
}>;

export type WorkflowTagAssignmentResult = WorkflowTagAssignment &
  Readonly<{ replayed: boolean }>;

export type WorkflowTagReplaceResult = WorkflowTagAssignmentResult &
  Readonly<{ tagIds: readonly string[] }>;

/** Tags, their workflows and tag commands. Page positions are tag and
 * workflow UUIDs; signed wire continuations belong to the API. */
export interface WorkflowTagDatabase {
  listTags(input: PageInput): Promise<Page<WorkflowTagRecord>>;
  listTagAssignments(
    input: PageInput & Readonly<{ tagId: string }>,
  ): Promise<Page<WorkflowTagAssignment>>;
  createTag(
    input: Command & Readonly<{ key: string }>,
  ): Promise<WorkflowTagCommandResult>;
  renameTag(
    input: TaggedCommand & Readonly<{ key: string }>,
  ): Promise<WorkflowTagCommandResult>;
  deleteTag(input: TaggedCommand): Promise<WorkflowTagDeleteResult>;
  replaceTags(
    input: AssignmentCommand & Readonly<{ tagIds: readonly string[] }>,
  ): Promise<WorkflowTagReplaceResult>;
  detachTag(
    input: AssignmentCommand & Readonly<{ tagId: string }>,
  ): Promise<WorkflowTagAssignmentResult>;
  close(): Promise<void>;
}

export const TAG_LIMIT = 256;

/** A tag on more workflows is detached through bounded cleanup first. */
export const TAG_DELETE_WORKFLOW_LIMIT = 50;

export const uuid = z.uuid().overwrite((value) => value.toLowerCase());

export const revision = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

const canonicalKey = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$(?![\s\S])/u);

export const key = z
  .string()
  .overwrite((value) =>
    value
      .replace(/^ +| +$(?![\s\S])/gu, '')
      .replace(/[A-Z]/gu, (letter) => letter.toLowerCase()),
  )
  .pipe(canonicalKey);

export const tag = z.object({ id: uuid, key: canonicalKey, revision }).strict();

export const assignment = z
  .object({ workflowId: uuid, organizationRevision: revision })
  .strict();

export const tagResult = z.object({ tag }).strict();

export const deleteResult = z
  .object({
    tagId: uuid,
    deleted: z.literal(true),
    detachedWorkflowCount: z
      .number()
      .int()
      .min(0)
      .max(TAG_DELETE_WORKFLOW_LIMIT),
  })
  .strict();

export const tagIds = z
  .array(uuid)
  .max(16)
  .refine((ids) => new Set(ids).size === ids.length)
  .overwrite((ids) => [...ids].sort());

export const replaceResult = assignment.extend({ tagIds }).strict();
