import { describe } from 'vitest';

import { registerComposesProductionPreviewAttemptsThroughOne } from './runtime/composes-production-preview-attempts-through-one.cases.js';
import { registerCleansEveryTransferredResourceCapabilityConstruction } from './runtime/cleans-every-transferred-resource-capability-construction.cases.js';
import { registerFailsClosedHeartbeatAbortOmitsDurable } from './runtime/fails-closed-heartbeat-abort-omits-durable.cases.js';
import { registerClosesPreviewStoreConsumerConstructionFails } from './runtime/closes-preview-store-consumer-construction-fails.cases.js';
describe('node-attempt runtime', () => {
  registerComposesProductionPreviewAttemptsThroughOne();

  registerCleansEveryTransferredResourceCapabilityConstruction();

  registerFailsClosedHeartbeatAbortOmitsDurable();

  registerClosesPreviewStoreConsumerConstructionFails();
});
