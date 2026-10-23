import { afterAll, beforeAll, describe } from 'vitest';

import {
  beforeAllFixture1,
  afterAllFixture2,
} from './tenant-context-hygiene/fixture.js';
import { registerRestoresActorDiscoveryBeforeSwitching } from './tenant-context-hygiene/restores-actor-discovery-before-switching.cases.js';
import { registerDestroysPooledClientLeaksWorkspace } from './tenant-context-hygiene/destroys-pooled-client-leaks-workspace.cases.js';
beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('tenant-scoped transaction hygiene', () => {
  registerRestoresActorDiscoveryBeforeSwitching();

  registerDestroysPooledClientLeaksWorkspace();
});
