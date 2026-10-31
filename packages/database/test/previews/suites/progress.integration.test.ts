import { beforeAll, afterAll, describe } from 'vitest';

import { beforeAllFixture1, afterAllFixture2 } from './progress/fixture.js';
import { registerFreezesCasesSharesOneSource } from './progress/freezes-cases-shares-one-source.cases.js';
import { registerRequiresExactEffectAcknowledgementAccepts } from './progress/requires-exact-effect-acknowledgement-accepts.cases.js';
import { registerFreezesPinsSharesExactOutput } from './progress/freezes-pins-shares-exact-output.cases.js';
import { registerKeepsSharedSourceFirstRun } from './progress/keeps-shared-source-first-run.cases.js';
import { registerKeepsCapturedVariableSet } from './progress/keeps-captured-variable-set.cases.js';
beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('durable serial draft suites', () => {
  registerFreezesCasesSharesOneSource();

  registerRequiresExactEffectAcknowledgementAccepts();

  registerFreezesPinsSharesExactOutput();

  registerKeepsCapturedVariableSet();

  registerKeepsSharedSourceFirstRun();
});
