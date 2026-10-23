import { errorRegistration } from '../../platform/http/problems/registry.js';
import { WorkflowCollaborationError } from '@pertexo/database/authoring';
import { applicationError } from '../../platform/http/index.js';

export const collaborationProblems = [
  errorRegistration(WorkflowCollaborationError, (error) => {
    return applicationError(
      error.reason === 'unavailable'
        ? 'resource.not_found'
        : error.reason === 'forbidden'
          ? 'auth.forbidden'
          : 'workflow.collaboration_conflict',
      { safeDetail: error.message },
    );
  }),
];
