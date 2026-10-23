import { describe } from 'vitest';

import { registerRecordsBoundedOutboxClaimBacklogLease } from './transport-metrics/records-bounded-outbox-claim-backlog-lease.cases.js';
import { registerRecordsStallsDispatchLatencyLifecycleArtifact } from './transport-metrics/records-stalls-dispatch-latency-lifecycle-artifact.cases.js';
describe('createTransportMetrics', () => {
  registerRecordsBoundedOutboxClaimBacklogLease();

  registerRecordsStallsDispatchLatencyLifecycleArtifact();
});
