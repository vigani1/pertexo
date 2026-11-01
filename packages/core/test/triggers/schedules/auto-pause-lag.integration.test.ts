import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './auto-pause-lag/fixture.js';
import { registerNeverAdmitsHourlySOccurrence } from './auto-pause-lag/never-admits-hourly-soccurrence.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('paused schedule admission after resume and scanner lag', () => {
  registerNeverAdmitsHourlySOccurrence();
});
