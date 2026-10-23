import { afterEach, describe } from 'vitest';

import { cleanWorkflowRunsRealNestHTTPStack } from './http-stack/fixture.js';
import { registerProtectsRecoveryPreviewAcceptanceCurrentCapabilities } from './http-stack/protects-recovery-preview-acceptance-current-capabilities.cases.js';
import { registerReadsExactRunStatisticsBehindRun } from './http-stack/reads-exact-run-statistics-behind-run.cases.js';
import { registerReadsRunInputOneStepOutput } from './http-stack/reads-run-input-one-step-output.cases.js';
describe('workflow runs real Nest HTTP stack', () => {
  afterEach(cleanWorkflowRunsRealNestHTTPStack);
  registerProtectsRecoveryPreviewAcceptanceCurrentCapabilities();

  registerReadsExactRunStatisticsBehindRun();

  registerReadsRunInputOneStepOutput();
});
