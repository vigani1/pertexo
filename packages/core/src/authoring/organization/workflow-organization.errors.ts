export class WorkflowOrganizationValidationError extends Error {
  override readonly name = 'WorkflowOrganizationValidationError';
  constructor() {
    super('Workflow organization command is invalid');
  }
}

export type WorkflowFolderConflictKind =
  | 'name'
  | 'limit'
  | 'revision'
  | 'hierarchy'
  | 'not_empty'
  | 'not_visible'
  | 'audience_review';

export class WorkflowFolderConflictError extends Error {
  override readonly name = 'WorkflowFolderConflictError';
  constructor(readonly kind: WorkflowFolderConflictKind) {
    super('Workflow folder command conflicts');
  }
}

export type WorkflowTagConflictKind =
  | 'key'
  | 'limit'
  | 'tag_revision'
  | 'delete_overflow'
  | 'organization_revision'
  | 'lifecycle';

export class WorkflowTagConflictError extends Error {
  override readonly name = 'WorkflowTagConflictError';
  constructor(readonly kind: WorkflowTagConflictKind) {
    super('Workflow organization command conflicts');
  }
}

/** A stored grant list is longer than the write path can ever make it. */
export class FolderSharingCorruptError extends Error {
  public override readonly name = 'FolderSharingCorruptError';
  public constructor() {
    super('Folder grants exceed the supported bound');
  }
}
