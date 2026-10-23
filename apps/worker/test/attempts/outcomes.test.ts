import { describe } from 'vitest';

import { registerStopsHeartbeatOwnershipAttemptCapabilityConstructor } from './outcomes/stops-heartbeat-ownership-attempt-capability-constructor.cases.js';
import { registerGrantsOneDispatchPermissionDurableS } from './outcomes/grants-one-dispatch-permission-durable-s.cases.js';
import { registerDoesNotReopenDispatchPermissionAfter } from './outcomes/does-not-reopen-dispatch-permission-after.cases.js';
import { registerRecordsDurableSBeforeDispatchingExecutor } from './outcomes/records-durable-sbefore-dispatching-executor.cases.js';
import { registerKeepsStepSOwnReasonIt } from './outcomes/keeps-step-sown-reason-it.cases.js';
import { registerPersistsRealHTTPCredentialResolutionOutage } from './outcomes/persists-real-httpcredential-resolution-outage.cases.js';
describe('NodeAttemptHandler', () => {
  registerStopsHeartbeatOwnershipAttemptCapabilityConstructor();

  registerGrantsOneDispatchPermissionDurableS();

  registerDoesNotReopenDispatchPermissionAfter();

  registerRecordsDurableSBeforeDispatchingExecutor();

  registerKeepsStepSOwnReasonIt();

  registerPersistsRealHTTPCredentialResolutionOutage();
});
