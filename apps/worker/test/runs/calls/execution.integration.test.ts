import { afterAll, beforeAll } from 'vitest';

import { fixture } from './fixtures.js';
import { describeIntegration } from './execution/fixture.js';
import { registerResumesTypedCallAfterWorkerRestart } from './execution/resumes-typed-call-after-worker-restart.cases.js';
import { registerRecoversDurableCallIdentityAcrossPaused } from './execution/recovers-durable-call-identity-across-paused.cases.js';
import { registerExecutesPrunesCallsTwoSerialEach } from './execution/executes-prunes-calls-two-serial-each.cases.js';
describeIntegration('Workflow Call execution through real transport', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  registerResumesTypedCallAfterWorkerRestart();

  registerRecoversDurableCallIdentityAcrossPaused();

  registerExecutesPrunesCallsTwoSerialEach();
});
