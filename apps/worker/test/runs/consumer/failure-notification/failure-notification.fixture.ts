import { describe } from 'vitest';

import { coordinatorFixture } from '../../../support/coordinator/consumer.js';

export const {
  actorId,
  adminUrl,
  apiQuery,
  databaseUrl,
  dispatcherUrl,
  enabled,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  startService,
  stopService,
  waitFor,
  workerQuery,
  workerUrl,
  workflowId,
  workspaceId,
} = coordinatorFixture;

export const describeIntegration = enabled ? describe : describe.skip;
