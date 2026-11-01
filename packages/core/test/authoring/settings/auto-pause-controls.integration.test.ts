import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './auto-pause-controls/fixture.js';
import { registerReadsDefaultsChangesIndependentlyVersioned } from './auto-pause-controls/reads-defaults-changes-independently-versioned.cases.js';
import { registerSerializesBlockedEvaluatorResumeSkips } from './auto-pause-controls/serializes-blocked-evaluator-resume-skips.cases.js';
import { registerRollsBackPauseStreakAudit } from './auto-pause-controls/rolls-back-pause-streak-audit.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('workflow auto pause operational controls', () => {
  registerReadsDefaultsChangesIndependentlyVersioned();

  registerSerializesBlockedEvaluatorResumeSkips();

  registerRollsBackPauseStreakAudit();
});
