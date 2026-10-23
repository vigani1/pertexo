import { describe } from 'vitest';

import { registerPreservesIteratorSRejectionWithoutLeaving } from './stream/preserves-iterator-srejection-without-leaving.cases.js';
import { registerPreservesUndefinedReadRejectionTogetherSubscription } from './stream/preserves-undefined-read-rejection-together-subscription.cases.js';
import { registerRepairsGapsSuppressesDuplicateLiveDelivery } from './stream/repairs-gaps-suppresses-duplicate-live-delivery.cases.js';
import { registerRejectsPersistedPayloadAbove256KiB } from './stream/rejects-persisted-payload-above256-ki-b.cases.js';
describe('run event SSE reconstruction', () => {
  registerPreservesIteratorSRejectionWithoutLeaving();

  registerPreservesUndefinedReadRejectionTogetherSubscription();

  registerRepairsGapsSuppressesDuplicateLiveDelivery();

  registerRejectsPersistedPayloadAbove256KiB();
});
