import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';

import { FailureNotificationContextSchema } from '@pertexo/workflow-model';

import {
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  parseDatabaseConfig,
  migrateDatabase,
  dropDisconnectedDatabase,
} from '@pertexo/database/testing';
import {
  CoordinatorRunStateCorruptError,
  createFailureNotificationStore,
  createDeadlineWakeupScanner,
  createDueNodeWakeupScanner,
  createNodeAttemptRunStore,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptConnectionFenceError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
} from '../../../src/testing.js';
import { createTestRunStore } from '../../support/run-advance-store.js';

export { actorId } from './fixture/context.js';
export { adminBaseUrl } from './fixture/context.js';
export { apiBaseUrl } from './fixture/context.js';
export { asAdmin } from './fixture/queries.js';
export { asOwner } from './fixture/queries.js';
export { asRuntime } from './fixture/queries.js';
export { checkpoint } from './fixture/records.js';
export { createDatabase } from './fixture/base.js';
export { coordinatorStoreApplicationName } from './fixture/context.js';
export { databaseName } from './fixture/context.js';
export { databaseUrl } from './fixture/context.js';
export { dropDatabase } from './fixture/base.js';
export { insertRun } from './fixture/records.js';
export { migrationBaseUrl } from './fixture/context.js';
export { migrationConfig } from './fixture/context.js';
export { namedDatabaseUrl } from './fixture/context.js';
export { nodeAttemptStore } from './fixture/base.js';
export { notificationConnectionId } from './fixture/context.js';
export { notificationDestinationId } from './fixture/context.js';
export { notificationSecretVersionId } from './fixture/context.js';
export { priorHeadDatabaseName } from './fixture/context.js';
export { rawStore } from './fixture/base.js';
export { seedIdentityAndExecutables } from './fixture/identity.js';
export { seedSucceededFact } from './fixture/records.js';
export { ownedDeliveryStore } from './fixture/delivery.js';
export { testDeliveries } from './fixture/base.js';
export { testDelivery } from './fixture/delivery.js';
export { versionA } from './fixture/context.js';
export { versionB } from './fixture/context.js';
export { waitForApplicationLocks } from './fixture/queries.js';
export { workerBaseUrl } from './fixture/context.js';
export { workflowA } from './fixture/context.js';
export { workflowB } from './fixture/context.js';
export { workspaceA } from './fixture/context.js';
export { workspaceB } from './fixture/context.js';
export { zeroDatabaseName } from './fixture/context.js';
export {
  CoordinatorRunStateCorruptError,
  FailureNotificationContextSchema,
  NodeAttemptConnectionFenceError,
  NodeAttemptDeliveryMismatchError,
  NodeAttemptDispatchBindingMismatchError,
  NodeAttemptStateCorruptError,
  Pool,
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  copyFile,
  createTestRunStore,
  createDeadlineWakeupScanner,
  createDueNodeWakeupScanner,
  createFailureNotificationStore,
  createHash,
  createNodeAttemptRunStore,
  dropDisconnectedDatabase,
  migrateDatabase,
  mkdtemp,
  parseDatabaseConfig,
  path,
  randomUUID,
  readdir,
  rm,
  tmpdir,
};
