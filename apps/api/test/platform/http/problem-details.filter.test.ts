import { describe } from 'vitest';

import { registerRendersAcceptedGenericOrganizationLifecycleConflict } from './problem-details.filter/renders-accepted-generic-organization-lifecycle-conflict.cases.js';
import { registerMapsKnownApplicationErrorSafeProblem } from './problem-details.filter/maps-known-application-error-safe-problem.cases.js';
import { registerPreservesFeatureValidationProblemS } from './problem-details.filter/preserves-feature-validation-problem-s.cases.js';
import { registerOmitsNestValidationIssueListContaining } from './problem-details.filter/omits-nest-validation-issue-list-containing.cases.js';
import { registerPreservesExplicitUnmappedHTTPStatusI } from './problem-details.filter/preserves-explicit-unmapped-httpstatus-i.cases.js';
import { registerExposesBoundedTypedWorkflowValidationIssues } from './problem-details.filter/exposes-bounded-typed-workflow-validation-issues.cases.js';
import { registerStillSendsSafeProblemExactlyOnce } from './problem-details.filter/still-sends-safe-problem-exactly-once.cases.js';
describe('RFC 9457 problem details filter', () => {
  registerRendersAcceptedGenericOrganizationLifecycleConflict();

  registerMapsKnownApplicationErrorSafeProblem();

  registerPreservesFeatureValidationProblemS();

  registerOmitsNestValidationIssueListContaining();

  registerPreservesExplicitUnmappedHTTPStatusI();

  registerExposesBoundedTypedWorkflowValidationIssues();

  registerStillSendsSafeProblemExactlyOnce();
});
