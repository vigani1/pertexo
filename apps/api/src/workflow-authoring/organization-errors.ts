import {
  WorkflowFavoriteRevisionConflictError,
  WorkflowOrganizationUnavailableError,
  WorkflowOrganizationValidationError,
  WorkflowTagConflictError,
  type WorkflowTagConflictKind,
} from '@pertexo/database/api';

import {
  applicationError,
  type ApplicationError,
} from '../platform/http/application-error.js';

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
        'The workflow tags have changed; reload them before confirming a new command.',
    },
  ),
  lifecycle: applicationError('workflow.lifecycle_conflict', {
    safeDetail:
      'The workflow lifecycle has changed; reload it before confirming a new command.',
  }),
};

/** Maps only organization failures; shared authoring failures retain their owner. */
export function mapWorkflowOrganizationError(
  error: unknown,
): ApplicationError | undefined {
  if (error instanceof WorkflowFavoriteRevisionConflictError)
    return applicationError('workflow.favorite_revision_conflict', {
      safeDetail:
        'The favorite has changed; reload it before confirming a new command.',
    });
  if (error instanceof WorkflowOrganizationUnavailableError)
    return applicationError('workflow.organization_unavailable', {
      safeDetail: 'Workflow organization is temporarily unavailable.',
    });
  if (error instanceof WorkflowOrganizationValidationError)
    return applicationError('request.invalid', {
      safeDetail: 'The workflow organization request is invalid.',
    });
  if (error instanceof WorkflowTagConflictError)
    return tagConflicts[error.kind];
  return undefined;
}
