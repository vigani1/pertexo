import type { workflowTags } from '@pertexo/database/schema';
import type { OrganizationRequestScope } from '../session.js';

export type Command = OrganizationRequestScope &
  Readonly<{ idempotencyKey: string }>;

export type PageInput = OrganizationRequestScope &
  Readonly<{ limit?: number; afterId?: string }>;

type TaggedCommand = Command &
  Readonly<{ tagId: string; expectedTagRevision: number }>;

export type AssignmentCommand = Command &
  Readonly<{ workflowId: string; expectedOrganizationRevision: number }>;

export type WorkflowTagRecord = Readonly<
  Pick<typeof workflowTags.$inferSelect, 'id' | 'key' | 'revision'>
>;

// Joins tag assignment identity with the current placement revision.
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

/** Page positions are tag and workflow UUIDs; signed wire continuations belong to the API. */
export type ListTagsInput = PageInput;
export type ListTagAssignmentsInput = PageInput & Readonly<{ tagId: string }>;
export type CreateTagInput = Command & Readonly<{ key: string }>;
export type RenameTagInput = TaggedCommand & Readonly<{ key: string }>;
export type DeleteTagInput = TaggedCommand;
export type ReplaceTagsInput = AssignmentCommand &
  Readonly<{ tagIds: readonly string[] }>;
export type DetachTagInput = AssignmentCommand & Readonly<{ tagId: string }>;
