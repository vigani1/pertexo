import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  WorkspaceRunQuotaExceededError,
  WorkspaceRunAdmissionDeniedError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  WorkflowPublishedVersionConflictError,
  createWorkflowRunDatabase,
  type WorkflowRunDatabase,
} from '@pertexo/database/runs';
import { WorkspaceAccessDeniedError } from '@pertexo/database/tenant-access';
import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_REGISTRY_RELEASE } from '@pertexo/node-catalog';
import { initialCheckpointFactory } from '@pertexo/execution';
import {
  composeExecutableCompatibilityRelease,
  WorkflowEngineError,
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
  ReplayWorkflowRunCommand,
  StartWorkflowRunCommand,
  WorkflowRunPersistence,
} from './ports.js';
import { WorkflowRunNotFoundError } from './use-cases.js';
import type { RunEventNotificationPublisher } from '../executions/index.js';

export type PostgresWorkflowRunPersistence = Readonly<{
  persistence: WorkflowRunPersistence;
  close(): Promise<void>;
}>;

export function createPostgresWorkflowRunPersistence(
  config: DatabaseConfig,
  databaseInput?: WorkflowRunDatabase,
  notifications?: RunEventNotificationPublisher,
  runtime?: DatabaseRuntime,
): PostgresWorkflowRunPersistence {
  const release = composeExecutableCompatibilityRelease(
    PLATFORM_REGISTRY_RELEASE,
  );
  const database = databaseInput ?? createWorkflowRunDatabase(config, runtime);
  const persistence: WorkflowRunPersistence = Object.freeze({
    usageCapacity: async (
      input: Parameters<WorkflowRunPersistence['usageCapacity']>[0],
    ) => {
      try {
        return await database.usageCapacity(input);
      } catch (error: unknown) {
        if (error instanceof WorkspaceAccessDeniedError)
          return throwWorkflowRunError(applicationError('resource.not_found'));
        return mapPersistenceError(error);
      }
    },
    start: (input: StartWorkflowRunCommand) =>
      executeAcceptance(database, input, release, notifications),
    replay: (input: ReplayWorkflowRunCommand) =>
      executeAcceptance(database, input, release, notifications),
    get: async (input: Readonly<{ workspaceId: string; runId: string }>) => {
      try {
        return await database.get(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    list: async (input: Parameters<WorkflowRunPersistence['list']>[0]) => {
      try {
        return await database.list(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    readInput: async (
      input: Parameters<WorkflowRunPersistence['readInput']>[0],
    ) => {
      try {
        return await database.readInput(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    readNodeRunOutput: async (
      input: Parameters<WorkflowRunPersistence['readNodeRunOutput']>[0],
    ) => {
      try {
        return await database.readNodeRunOutput(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    readNodeRunInput: async (
      input: Parameters<WorkflowRunPersistence['readNodeRunInput']>[0],
    ) => {
      try {
        return await database.readNodeRunInput(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    stepHealth: async (
      input: Parameters<WorkflowRunPersistence['stepHealth']>[0],
    ) => {
      try {
        return await database.stepHealth(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    stepRuns: async (
      input: Parameters<WorkflowRunPersistence['stepRuns']>[0],
    ) => {
      try {
        return await database.stepRuns(input);
      } catch (error: unknown) {
        return mapPersistenceError(error);
      }
    },
    statistics: async (
      input: Parameters<WorkflowRunPersistence['statistics']>[0],
    ) => {
      try {
        return await database.statistics(input);
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

type WorkflowRunAcceptanceResult = Awaited<
  ReturnType<WorkflowRunDatabase['start']>
>;

async function executeAcceptance(
  database: WorkflowRunDatabase,
  input: StartWorkflowRunCommand | ReplayWorkflowRunCommand,
  release: ReturnType<typeof composeExecutableCompatibilityRelease>,
  notifications: RunEventNotificationPublisher | undefined,
): Promise<WorkflowRunAcceptanceResult> {
  try {
    const result =
      'workflowId' in input
        ? await database.start({
            ...input,
            checkpointFactory: initialCheckpointFactory({ release }),
          })
        : await database.replay({
            ...input,
            checkpointFactory: initialCheckpointFactory({ release }),
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
  if (error instanceof WorkflowPublishedVersionConflictError)
    return throwWorkflowRunError(
      applicationError('workflow.published_version_conflict', {
        safeDetail:
          'The published version changed. Review the input in the new version context and confirm a new run.',
      }),
    );
  if (error instanceof DatabaseWorkflowRunNotFoundError)
    throw new WorkflowRunNotFoundError();
  if (error instanceof DatabaseWorkflowRunNotExecutableError)
    throw new WorkflowRunNotExecutableError();
  if (error instanceof WorkflowEngineError)
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
