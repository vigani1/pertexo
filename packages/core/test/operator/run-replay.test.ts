import {
  beforeEachFixture1,
  beforeEachFixture2,
} from './run-replay/fixture.js';

import { beforeEach, describe } from 'vitest';

import { registerValidatesAbortSignalPublicInputBefore } from './run-replay/validates-abort-signal-public-input-before.cases.js';
import { registerProcessesExactEvidenceDeliveryIdentity } from './run-replay/processes-exact-evidence-delivery-identity.cases.js';
describe('operator run replay validation', () => {
  beforeEach(beforeEachFixture1);
  registerValidatesAbortSignalPublicInputBefore();
});
describe('unknown-outcome reconciliation validation', () => {
  beforeEach(beforeEachFixture2);
  registerProcessesExactEvidenceDeliveryIdentity();
});
