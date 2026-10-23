import { beforeEachFixture1, beforeEachFixture2 } from './scanner/fixture.js';

import { beforeEach, describe } from 'vitest';

import { registerPerformsNoClaimWorkPre } from './scanner/performs-no-claim-work-pre.cases.js';
import { registerScheduleMisfireDisposition } from './scanner/misfire-disposition.cases.js';
describe('schedule trigger scanner claim ownership', () => {
  beforeEach(beforeEachFixture1);
  registerPerformsNoClaimWorkPre();
});
describe('schedule misfire disposition (ADR 049)', () => {
  beforeEach(beforeEachFixture2);
  registerScheduleMisfireDisposition();
});
