import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  RegionalWriteAdmissionPausedError,
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  createWorkflowRunDatabase,
  type DatabaseConfig,
  type WorkflowRunDatabase,
} from '@pertexo/database/api';
import {
  platformExecutableRegistryHistory,
  platformRegistryReleaseSupport,
  type PlatformReleaseCohort,
} from '@pertexo/node-catalog';
import {
  composeExecutableCompatibilityRelease,
  createExecutableCompatibilityReleaseHistory,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';

import {
  WorkflowRunIdempotencyConflictError,
  WorkflowRunNotCancelableError,
  WorkflowRunNotExecutableError,
  throwWorkflowRunError,
} from './errors.js';
import { applicationError } from '../platform/http/index.js';
import type {
  CancelWorkflowRunCommand,
  StartWorkflowRunCommand,
  WorkflowRunPersistence,
} from './ports.js';
import { WorkflowRunNotFoundError } from './use-cases.js';
import {
  createInitialWorkflowCheckpoint,
  InitialWorkflowCheckpointError,
  type RunEventNotificationPublisher,
} from '../executions/index.js';

export type PostgresWorkflowRunPersistence = Readonly<{
  persistence: WorkflowRunPersistence;
  close(): Promise<void>;
}>;

export function createPostgresWorkflowRunPersistence(
  config: DatabaseConfig,
  databaseInput?: WorkflowRunDatabase,
  notifications?: RunEventNotificationPublisher,
  releaseCohort: PlatformReleaseCohort = 'core',
): PostgresWorkflowRunPersistence {
  const releaseSupport = createExecutableCompatibilityReleaseHistory(
    platformExecutableRegistryHistory(releaseCohort).map(
      composeExecutableCompatibilityRelease,
    ),
  );
  const database =
    databaseInput ??
    createWorkflowRunDatabase(
      config,
      createExecutableCompatibilityReleaseSupport(
        platformRegistryReleaseSupport(releaseCohort).map(
          composeExecutableCompatibilityRelease,
        ),
      ).descriptions,
    );
  const persistence: WorkflowRunPersistence = Object.freeze({
    start: async (input: StartWorkflowRunCommand) => {
      try {
        const result = await database.start({
          ...input,
          checkpointFactory: (projection, currentCompatibilityRelease) =>
            createInitialWorkflowCheckpoint(
              projection,
              releaseSupport,
              currentCompatibilityRelease,
            ),
        });
        if (!result.replayed)
          await publishHint(notifications, {
            workspaceId: result.run.workspaceId,
            runId: result.run.id,
            sequence: 1,
          });
        return result;
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    get: async (input: Readonly<{ workspaceId: string; runId: string }>) => {
      try {
        return await database.get(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    cancel: async (input: CancelWorkflowRunCommand) => {
      try {
        const result = await database.cancel(input);
        if (result.eventSequence !== null)
          await publishHint(notifications, {
            workspaceId: result.run.workspaceId,
            runId: result.run.id,
            sequence: result.eventSequence,
          });
        return {
          run: result.run,
          alreadyRequested: result.alreadyRequested,
        };
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
  });
  return Object.freeze({
    persistence,
    close: (): Promise<void> => database.close(),
  });
}

async function publishHint(
  notifications: RunEventNotificationPublisher | undefined,
  reference: Parameters<RunEventNotificationPublisher['publish']>[0],
): Promise<void> {
  if (notifications === undefined) return;
  try {
    await notifications.publish(reference);
  } catch {
    // Redis is a wake-up hint only. PostgreSQL already committed the command,
    // and reconnect/backfill reconstructs every authoritative event.
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof DatabaseWorkflowRunNotFoundError)
    throw new WorkflowRunNotFoundError();
  if (error instanceof DatabaseWorkflowRunNotExecutableError)
    throw new WorkflowRunNotExecutableError();
  if (error instanceof InitialWorkflowCheckpointError)
    throw new WorkflowRunNotExecutableError();
  if (error instanceof IdempotencyRequestConflictError)
    throw new WorkflowRunIdempotencyConflictError();
  if (error instanceof WorkspaceRunQuotaExceededError)
    return throwWorkflowRunError(
      applicationError('workspace.quota_exceeded', {
        safeDetail: 'The workspace queued-run limit has been reached.',
        details: { retryAfterSeconds: error.retryAfterSeconds },
      }),
    );
  if (error instanceof RegionalWriteAdmissionPausedError)
    return throwWorkflowRunError(
      applicationError('platform.write_paused', {
        safeDetail:
          'Durable workflow starts are paused while regional recovery protection catches up.',
        details: { retryAfterSeconds: error.retryAfterSeconds },
      }),
    );
  if (error instanceof WorkspaceRunAdmissionDeniedError)
    return throwWorkflowRunError(
      applicationError('workspace.conflict', {
        safeDetail: 'The workspace is not accepting new runs.',
      }),
    );
  if (error instanceof ExecutionStateConflictError) {
    if (error.message === 'execution.run_not_found')
      throw new WorkflowRunNotFoundError();
    if (
      error.message === 'execution.run_terminal' ||
      error.message === 'execution.cancel_request_conflict'
    )
      throw new WorkflowRunNotCancelableError();
  }
  throw error;
}
