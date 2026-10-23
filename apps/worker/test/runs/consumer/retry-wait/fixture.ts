import { describe } from 'vitest';

import { coordinatorFixture } from '../../../support/coordinator/consumer.js';

export const {
  adminUrl,
  apiQuery,
  databaseUrl,
  dispatcherUrl,
  enabled,
  ownerQuery,
  redisConnection,
  redisUrl,
  restoreServicesAndClose,
  setup,
  waitFor,
  waitWorkflowVersionId,
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
} = coordinatorFixture;

export const describeIntegration = enabled ? describe : describe.skip;
