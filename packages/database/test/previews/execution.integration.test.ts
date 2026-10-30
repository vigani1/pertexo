import { afterAll, beforeAll, beforeEach, describe } from 'vitest';

import {
  resetFixture,
  beforeAllFixture1,
  afterAllFixture2,
} from './execution/fixture.js';
import { registerCapturesVariablesOnPreviewAdmission } from './execution/captures-variables-on-preview-admission.cases.js';
import { registerKeepsSimultaneousFirstRequestsBehind } from './execution/keeps-simultaneous-first-requests-behind.cases.js';
import { registerCopiesSuccessfulUnexpiredPriorOutput } from './execution/copies-successful-unexpired-prior-output.cases.js';
import { registerReadsUnexpiredTenantScopedPreview } from './execution/reads-unexpired-tenant-scoped-preview.cases.js';
import { registerBoundsRetentionExecutionDeadline } from './execution/bounds-retention-execution-deadline.cases.js';
beforeAll(beforeAllFixture1);
beforeEach(resetFixture);
afterAll(afterAllFixture2);
describe('durable preview acceptance', () => {
  registerCapturesVariablesOnPreviewAdmission();

  registerKeepsSimultaneousFirstRequestsBehind();

  registerCopiesSuccessfulUnexpiredPriorOutput();

  registerReadsUnexpiredTenantScopedPreview();

  registerBoundsRetentionExecutionDeadline();
});
