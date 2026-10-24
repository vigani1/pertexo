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
