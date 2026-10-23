import { beforeEachFixture1 } from './completion-store/fixture.js';

import { beforeEach, describe } from 'vitest';

import { registerCompletionPolicy } from './completion-store/delivery-policy.cases.js';
import { registerInvalidCompletionInputs } from './completion-store/invalid-completion.cases.js';
import { registerRejectsPreAbortedCompletionBefore } from './completion-store/rejects-pre-aborted-completion-before.cases.js';
describe('failure notification completion policy', () => {
  beforeEach(beforeEachFixture1);
  registerCompletionPolicy();

  registerInvalidCompletionInputs();

  registerRejectsPreAbortedCompletionBefore();
});
