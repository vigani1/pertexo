import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import {
  EMPTY_DEFINITION_CATALOG,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
} from '@pertexo/workflow-model/server';
import { parseDatabaseConfig } from '../../src/config.js';
import { CONNECTION_AUTH_TYPE } from '../../src/connections/contract.js';
import { createConnectionDatabase } from '../../src/connections/repository.js';

import {IdempotencyConflictError} from '../../src/platform/idempotency/repository.js';
import {checkDatabaseReadiness} from '../../src/platform/readiness.queries.js';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
} from '../../src/authoring/workflows/database.js';
import { createWorkflowAuthoringFixtureDatabase as createWorkflowAuthoringDatabase } from './workflow-authoring-admission.fixture.js';
import { createWorkflowIntegrationUsageDatabase } from '../../src/connections/discovery/integration-usage.queries.js';

export {
  CONNECTION_AUTH_TYPE,
  EMPTY_DEFINITION_CATALOG,
  IdempotencyConflictError,
  Pool,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  checkDatabaseReadiness,
  createConnectionDatabase,
  createHash,
  createWorkflowAuthoringDatabase,
  createWorkflowIntegrationUsageDatabase,
  parseDatabaseConfig,
  randomUUID,
  workflowCompatibilityReport,
  workflowDraftRepresentationTag,
};
export {
  migrationUrl,
  apiUrl,
  workerUrl,
  dispatcherUrl,
  purgeTestWorkspace,
  enforceTestRetention,
  migrationConfig,
  identity,
  ownerPool,
  apiPool,
  workerPool,
  dispatcherPool,
  actorId,
  otherActorId,
  workspaceId,
  workflowId,
  otherWorkspaceId,
  otherWorkflowId,
  otherVersionId,
  authoring,
} from './workflow-authoring/base.js';
export {
  deferred,
  waitForOperationEntry,
  finishControlledScenario,
  finishTransactionClient,
  withApplicationName,
  waitForPostgresLock,
} from './workflow-authoring/coordination.js';
export {
  type WritePoint,
  failAtWrite,
  holdAtWrite,
} from './workflow-authoring/write-points.js';
export {
  publicationWrite,
  archiveWrite,
  renameWrite,
  draftWrite,
  duplicateWrite,
  importWrite,
} from './workflow-authoring/writes.js';
export {
  emptyGraph,
  draftNode,
  testDefinitionCatalog,
  baselineEmptyDefinitionCatalog,
  currentRepresentationTag,
  saveCurrentDraft,
} from './workflow-authoring/drafts.js';
export { executeAsOwner, queryAsOwner } from './workflow-authoring/queries.js';
