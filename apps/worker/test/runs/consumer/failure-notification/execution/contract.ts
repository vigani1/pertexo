import type { createFailureNotificationStore } from '@pertexo/database/testing';

import type { seedFailureNotificationProof } from './seed.js';

export type FailureNotificationScenario = Awaited<
  ReturnType<typeof seedFailureNotificationProof>
>;

export type FailureProofStore = ReturnType<
  typeof createFailureNotificationStore
>;
