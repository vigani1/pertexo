import { vi } from 'vitest';
import {
  enabled,
  adminUrl,
  apiUrl,
  workerUrl,
  dispatcherUrl,
  databaseUrl,
  redisUrl,
  actorId,
  workspaceId,
  workflowId,
  workflowVersionId,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  switchWorkflowId,
  switchWorkflowVersionId,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  waitWorkflowId,
  waitWorkflowVersionId,
  redisConnection,
} from './environment.js';
import { stopService, startService } from './services.js';
import {
  ownerPool,
  workerPool,
  apiDatabase,
  ownerPoolCreated,
  workerPoolCreated,
  apiDatabaseCreated,
  ownerQuery,
  workerQuery,
  apiQuery,
  setupFixture,
  restoreServicesAndCleanupFixture,
} from './lifecycle.js';
import type { CoordinatorIntegrationFixture } from './contract.js';

export async function waitFor<T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const result = await vi.waitUntil(
    async () => {
      const value = await operation();
      return predicate(value) ? { value } : false;
    },
    { timeout: timeoutMs, interval: 25 },
  );
  return result.value;
}

export const coordinatorFixture: CoordinatorIntegrationFixture = Object.freeze({
  actorId,
  adminUrl,
  get apiDatabase() {
    if (!apiDatabaseCreated)
      throw new Error('Coordinator API database is not initialized');
    return apiDatabase;
  },
  apiQuery,
  apiUrl,
  conditionWorkflowId,
  conditionWorkflowVersionId,
  databaseUrl,
  dispatcherUrl,
  enabled,
  forEachWorkflowId,
  forEachWorkflowVersionId,
  nestedParallelWorkflowId,
  nestedParallelWorkflowVersionId,
  get ownerPool() {
    if (!ownerPoolCreated)
      throw new Error('Coordinator owner pool is not initialized');
    return ownerPool;
  },
  ownerQuery,
  parallelWorkflowId,
  parallelWorkflowVersionId,
  redisConnection,
  redisUrl,
  restoreServicesAndClose: restoreServicesAndCleanupFixture,
  setup: setupFixture,
  startService,
  stopService,
  switchWorkflowId,
  switchWorkflowVersionId,
  waitFor,
  waitWorkflowId,
  waitWorkflowVersionId,
  get workerPool() {
    if (!workerPoolCreated)
      throw new Error('Coordinator worker pool is not initialized');
    return workerPool;
  },
  workerQuery,
  workerUrl,
  workflowId,
  workflowVersionId,
  workspaceId,
});
