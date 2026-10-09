import {
  WorkflowFolderConflictError,
  WorkflowOrganizationValidationError,
  WorkflowTagConflictError,
  type WorkflowFolderConflictKind,
  type WorkflowTagConflictKind,
} from '@pertexo/database/authoring';

import {
  applicationError,
  type ApplicationError,
} from '../../platform/http/application-error.js';

const tagConflicts: Readonly<
  Record<WorkflowTagConflictKind, ApplicationError>
> = {
  key: applicationError('workflow.tag_key_conflict', {
    safeDetail: 'The tag key conflicts with the current workspace vocabulary.',
  }),
  limit: applicationError('workflow.tag_limit_exceeded', {
    safeDetail: 'The workspace tag limit has been reached.',
  }),
  tag_revision: applicationError('workflow.tag_revision_conflict', {
    safeDetail:
      'The tag has changed; reload it before confirming a new command.',
  }),
  delete_overflow: applicationError('workflow.tag_delete_overflow', {
    safeDetail: 'The tag has too many assignments for a single delete command.',
  }),
  organization_revision: applicationError(
    'workflow.organization_revision_conflict',
    {
      safeDetail:
        'The workflow organization has changed; reload it before confirming a new command.',
    },
  ),
  lifecycle: applicationError('workflow.lifecycle_conflict', {
    safeDetail:
      'The workflow lifecycle has changed; reload it before confirming a new command.',
    // Organization endpoints use generic ApiProblem, not lifecycle CAS metadata.
    // This discriminator is internal and is never projected into the response.
    details: { conflictProjection: 'organization' },
  }),
};

const folderConflicts: Readonly<
  Record<WorkflowFolderConflictKind, ApplicationError>
> = {
  name: applicationError('workflow.folder_name_conflict', {
    safeDetail: 'The folder name conflicts with another folder in this parent.',
  }),
  limit: applicationError('workflow.folder_limit_exceeded', {
    safeDetail: 'The workspace folder limit has been reached.',
  }),
  revision: applicationError('workflow.folder_revision_conflict', {
    safeDetail:
      'The folder has changed; reload it before confirming a new command.',
  }),
  hierarchy: applicationError('workflow.folder_hierarchy_conflict', {
    safeDetail: 'The requested folder hierarchy is not allowed.',
  }),
  not_empty: applicationError('workflow.folder_not_empty', {
    safeDetail: 'The folder must be empty before it can be deleted.',
  }),
  not_visible: applicationError('workflow.folder_not_visible', {
    safeDetail: 'The folder is not visible in the current workspace.',
  }),
};

/** Maps only organization failures; shared authoring failures retain their owner. */
export function mapWorkflowOrganizationError(
  error: unknown,
): ApplicationError | undefined {
  if (error instanceof WorkflowOrganizationValidationError)
    return applicationError('request.invalid', {
      safeDetail: 'The workflow organization request is invalid.',
    });
  if (error instanceof WorkflowTagConflictError)
    return tagConflicts[error.kind];
  if (error instanceof WorkflowFolderConflictError)
    return Object.hasOwn(folderConflicts, error.kind)
      ? folderConflicts[error.kind]
      : undefined;
  return undefined;
}
