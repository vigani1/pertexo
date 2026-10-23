import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './workspace-deletion/fixture.js';
import { registerRejectsActorWhoIsNot } from './workspace-deletion/rejects-actor-who-is-not.cases.js';
beforeAll(beforeAllFixture1, 120_000);
afterAll(afterAllFixture2);
describe('workspace deletion and restore', () => {
  registerRejectsActorWhoIsNot();
});
