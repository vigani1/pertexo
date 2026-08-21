import {
  ExecutionStateConflictError,
  IdempotencyRequestConflictError,
  WorkflowRunNotExecutableError as DatabaseWorkflowRunNotExecutableError,
  WorkflowRunNotFoundError as DatabaseWorkflowRunNotFoundError,
  createWorkflowRunDatabase,
  type DatabaseConfig,
  type PublishedWorkflowV2Projection,
  type WorkflowRunDatabase,
} from '@pertexo/database';
import { CORE_REGISTRY_RELEASE } from '@pertexo/nodes-core';
import {
  WorkflowEngineError,
  composeExecutableCompatibilityRelease,
  createCheckpoint,
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

export const PHASE3_API_ENGINE_VERSION = 'phase3-engine-v1';
export const PHASE3_API_ITERATION_BUDGET = 1_000;

export type PostgresWorkflowRunPersistence = Readonly<{
  persistence: WorkflowRunPersistence;
  close(): Promise<void>;
}>;

export function createPostgresWorkflowRunPersistence(
  config: DatabaseConfig,
  database: WorkflowRunDatabase = createWorkflowRunDatabase(config),
): PostgresWorkflowRunPersistence {
  const release = composeExecutableCompatibilityRelease(CORE_REGISTRY_RELEASE);
  const persistence: WorkflowRunPersistence = Object.freeze({
    start: async (input: StartWorkflowRunCommand) => {
      try {
        return await database.start({
          ...input,
          checkpointFactory: (projection) =>
            initialCheckpoint(projection, release),
        });
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
        return await database.cancel(input);
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

function initialCheckpoint(
  projection: PublishedWorkflowV2Projection,
  release: unknown,
) {
  try {
    const executable = verifyWorkflowExecutableV2({
      envelope: projection.executableJson,
      checksum: projection.checksum,
      admissionRelease: release,
      currentRelease: release,
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
