import type { ApiProblemCode } from '@pertexo/contracts';
import { errorRegistration } from '../../platform/http/problems/registry.js';
import { FederationConflictError } from '@pertexo/core/tenant-access';
import { applicationError } from '../../platform/http/index.js';

export const federationProblems = [
  errorRegistration(FederationConflictError, (error) => {
    return applicationError(
      FEDERATION_PROBLEMS.get(error.reason) ?? 'workspace.conflict',
      { safeDetail: error.message },
    );
  }),
];

const FEDERATION_PROBLEMS = new Map<
  FederationConflictError['reason'],
  ApiProblemCode
>([
  ['owner_required', 'auth.forbidden'],
  ['dns_unverified', 'request.invalid'],
]);
