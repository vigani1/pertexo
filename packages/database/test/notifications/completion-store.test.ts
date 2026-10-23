import { beforeEachFixture1 } from './completion-store/fixture.js';

import { beforeEach, describe } from 'vitest';

import { registerScenario } from './completion-store/scenario.cases.js';
import { registerRejectsInvalid02Before } from './completion-store/rejects-invalid02-before.cases.js';
import { registerRejectsPreAbortedCompletionBefore } from './completion-store/rejects-pre-aborted-completion-before.cases.js';
describe('failure notification completion policy', () => {
  beforeEach(beforeEachFixture1);
  registerScenario();

  registerRejectsInvalid02Before();

  registerRejectsPreAbortedCompletionBefore();
});
