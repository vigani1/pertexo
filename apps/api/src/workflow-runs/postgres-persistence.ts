import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  createWorkflowRunDatabase,
  type CompatibilityReleaseExpectation,
  type DatabaseConfig,
  type PublishedWorkflowV2Projection,
  type WorkflowRunDatabase,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE_SUPPORT } from '@pertexo/nodes-core';
import {
  WorkflowEngineError,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
  createExecutableCompatibilityReleaseSupport,
  type ExecutableCompatibilityReleaseSupport,
  verifyWorkflowExecutableV2,
} from '@pertexo/workflow-engine';

import {
  WorkflowRunIdempotencyConflictError,
  WorkflowRunNotCancelableError,
  WorkflowRunNotExecutableError,
} from './errors.js';
import type {
  CancelWorkflowRunCommand,
  StartWorkflowRunCommand,
  WorkflowRunPersistence,
} from './ports.js';
import { WorkflowRunNotFoundError } from './use-cases.js';
import type { RunEventNotificationPublisher } from '../executions/index.js';

export const PHASE3_API_ENGINE_VERSION = 'phase3-engine-v1';
export const PHASE3_API_ITERATION_BUDGET = 1_000;

export type PostgresWorkflowRunPersistence = Readonly<{
  persistence: WorkflowRunPersistence;
  close(): Promise<void>;
}>;

export function createPostgresWorkflowRunPersistence(
  config: DatabaseConfig,
  databaseInput?: WorkflowRunDatabase,
  notifications?: RunEventNotificationPublisher,
): PostgresWorkflowRunPersistence {
  const releaseSupport = createExecutableCompatibilityReleaseSupport(
    CORE_REGISTRY_RELEASE_SUPPORT.map(composeExecutableCompatibilityRelease),
  );
  const database =
    databaseInput ??
    createWorkflowRunDatabase(config, releaseSupport.descriptions);
  const persistence: WorkflowRunPersistence = Object.freeze({
    start: async (input: StartWorkflowRunCommand) => {
      try {
        const result = await database.start({
          ...input,
          checkpointFactory: (projection, currentCompatibilityRelease) =>
            initialCheckpoint(
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

function initialCheckpoint(
  projection: PublishedWorkflowV2Projection,
  releaseSupport: ExecutableCompatibilityReleaseSupport,
  currentCompatibilityRelease: CompatibilityReleaseExpectation,
) {
  try {
    const admissionDescription = releaseSupport.descriptions.find(
      ({ epoch }) => epoch === projection.compatibilityReleaseEpoch,
    );
    if (admissionDescription === undefined)
      throw new WorkflowRunNotExecutableError();
    const admissionRelease = releaseSupport.resolve(
      admissionDescription.epoch,
      admissionDescription.fingerprint,
    );
    const currentRelease = releaseSupport.resolve(
      currentCompatibilityRelease.epoch,
      currentCompatibilityRelease.fingerprint,
    );
    const executable = verifyWorkflowExecutableV2({
      envelope: projection.executableJson,
      checksum: projection.checksum,
      admissionRelease,
      currentRelease,
    });
    if (
      executable.envelope.compatibilityReleaseEpoch !==
      projection.compatibilityReleaseEpoch
    )
      throw new WorkflowRunNotExecutableError();
    return Object.freeze({
      engineVersion: PHASE3_API_ENGINE_VERSION,
      checkpoint: createCheckpoint({
        engineVersion: PHASE3_API_ENGINE_VERSION,
        workflowVersionId: projection.id,
        iterationBudget: PHASE3_API_ITERATION_BUDGET,
        nextEventSequence: 2,
      }),
    });
  } catch (error: unknown) {
    if (error instanceof WorkflowRunNotExecutableError) throw error;
    if (error instanceof WorkflowEngineError)
      throw new WorkflowRunNotExecutableError();
    throw error;
  }
}

function mapPersistenceError(error: unknown): never {
  if (error instanceof DatabaseWorkflowRunNotFoundError)
    throw new WorkflowRunNotFoundError();
  if (error instanceof DatabaseWorkflowRunNotExecutableError)
    throw new WorkflowRunNotExecutableError();
  if (error instanceof IdempotencyRequestConflictError)
    throw new WorkflowRunIdempotencyConflictError();
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
