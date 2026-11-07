import type { createWorkspaceDatabase } from '@pertexo/database/testing';

import type { Pool } from 'pg';

import type { databaseUrl, redisConnection } from './environment.js';
import type { stopService, startService } from './services.js';
import type {
  ownerQuery,
  workerQuery,
  apiQuery,
  setupFixture,
  restoreServicesAndCleanupFixture,
} from './lifecycle.js';
import type { waitFor } from './context.js';

export interface CoordinatorIntegrationFixture {
  readonly actorId: string;
  readonly adminUrl: string;
  readonly apiDatabase: ReturnType<typeof createWorkspaceDatabase>;
  readonly apiQuery: typeof apiQuery;
  readonly apiUrl: string;
  readonly conditionWorkflowId: string;
  readonly conditionWorkflowVersionId: string;
  readonly databaseUrl: typeof databaseUrl;
  readonly dispatcherUrl: string;
  readonly enabled: boolean;
  readonly forEachWorkflowId: string;
  readonly forEachWorkflowVersionId: string;
  readonly nestedParallelWorkflowId: string;
  readonly nestedParallelWorkflowVersionId: string;
  readonly ownerPool: Pool;
  readonly ownerQuery: typeof ownerQuery;
  readonly parallelWorkflowId: string;
  readonly parallelWorkflowVersionId: string;
  readonly redisConnection: typeof redisConnection;
  readonly redisUrl: string;
  readonly restoreServicesAndClose: typeof restoreServicesAndCleanupFixture;
  readonly setup: typeof setupFixture;
  readonly startService: typeof startService;
  readonly stopService: typeof stopService;
  readonly switchWorkflowId: string;
  readonly switchWorkflowVersionId: string;
  readonly waitFor: typeof waitFor;
  readonly waitWorkflowId: string;
  readonly waitWorkflowVersionId: string;
  readonly workerPool: Pool;
  readonly workerQuery: typeof workerQuery;
  readonly workerUrl: string;
  readonly workflowId: string;
  readonly workflowVersionId: string;
  readonly workspaceId: string;
}
