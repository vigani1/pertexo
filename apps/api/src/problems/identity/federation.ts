import { errorRegistration } from '../../platform/http/problems/registry.js';
import { FederationConflictError } from '@pertexo/database/tenant-access';
import { applicationError } from '../../platform/http/index.js';

export const federationProblems = [
  errorRegistration(FederationConflictError, (error) => {
    return applicationError(
      error.reason === 'owner_required'
        ? 'auth.forbidden'
        : error.reason === 'dns_unverified'
          ? 'request.invalid'
          : 'workspace.conflict',
      { safeDetail: error.message },
    );
  }),
];
