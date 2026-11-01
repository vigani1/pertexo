import type { ApiProblemCode } from '@pertexo/contracts';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import { WorkflowCollaborationError } from '@pertexo/core/authoring';
import { applicationError } from '../../platform/http/index.js';

export const collaborationProblems = [
  errorRegistration(WorkflowCollaborationError, (error) => {
    return applicationError(
      COLLABORATION_PROBLEMS.get(error.reason) ??
        'workflow.collaboration_conflict',
      { safeDetail: error.message },
    );
  }),
];

const COLLABORATION_PROBLEMS = new Map<
  WorkflowCollaborationError['reason'],
  ApiProblemCode
>([
  ['unavailable', 'resource.not_found'],
  ['forbidden', 'auth.forbidden'],
]);
