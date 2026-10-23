import { afterEach, describe } from 'vitest';

import { cleanAppsWorkerTestTransportOutboxDispatcherOutboxDispatcherFixture } from './outbox-dispatcher/fixture.js';
import { registerHoldsEveryRowWorkerConsumesNo } from './outbox-dispatcher/holds-every-row-worker-consumes-no.cases.js';
import { registerOwnsTimedOutPublicationMarkThrough } from './outbox-dispatcher/owns-timed-out-publication-mark-through.cases.js';
import { registerSerializesAbortRespectingCapacitySamplesAt } from './outbox-dispatcher/serializes-abort-respecting-capacity-samples-at.cases.js';
import { registerFailsChecksumMismatchThroughBoundedRelease } from './outbox-dispatcher/fails-checksum-mismatch-through-bounded-release.cases.js';
import { registerWaitsAdmittedQueueBacklogObservationsBefore } from './outbox-dispatcher/waits-admitted-queue-backlog-observations-before.cases.js';
import { registerRestoresIdleIntervalAfterFailedClaim } from './outbox-dispatcher/restores-idle-interval-after-failed-claim.cases.js';
describe('outbox dispatcher', () => {
  afterEach(
    cleanAppsWorkerTestTransportOutboxDispatcherOutboxDispatcherFixture,
  );
  registerHoldsEveryRowWorkerConsumesNo();

  registerOwnsTimedOutPublicationMarkThrough();

  registerSerializesAbortRespectingCapacitySamplesAt();

  registerFailsChecksumMismatchThroughBoundedRelease();

  registerWaitsAdmittedQueueBacklogObservationsBefore();

  registerRestoresIdleIntervalAfterFailedClaim();
});
