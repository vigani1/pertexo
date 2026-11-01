import { errorRegistration } from '../../platform/http/problems/registry.js';
import { GovernanceError } from '@pertexo/core/governance';
import { applicationError } from '../../platform/http/index.js';

export const governanceProblems = [
  errorRegistration(GovernanceError, (error) => {
    return applicationError(
      error.reason === 'conflict' ? 'workspace.conflict' : 'request.invalid',
      { safeDetail: error.message },
    );
  }),
];
