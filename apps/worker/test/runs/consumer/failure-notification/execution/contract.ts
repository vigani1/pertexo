import type { createFailureNotificationStore } from '@pertexo/core/testing';

import type { seedFailureNotificationProof } from './seed.js';

export type FailureNotificationScenario = Awaited<
  ReturnType<typeof seedFailureNotificationProof>
>;

export type FailureProofStore = ReturnType<
  typeof createFailureNotificationStore
>;
