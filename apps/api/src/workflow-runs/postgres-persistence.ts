import {
  createWorkflowRunDatabase,
  type WorkflowRunDatabase,
} from '@pertexo/core/runs';

import type {
  DatabaseConfig,
  DatabaseRuntime,
} from '@pertexo/database/platform';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import {
  recoveryPreparation,
  initialCheckpointFactory,
} from '@pertexo/core/runs';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';

import type {
  CancelWorkflowRunCommand,
  ReplayWorkflowRunCommand,
  StartWorkflowRunCommand,
  WorkflowRunPersistence,
} from './ports.js';

import type { RunEventNotificationPublisher } from '@pertexo/queue';

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
  const catalog = composeExecutableCatalog(PLATFORM_NODE_CATALOG);
  const database = databaseInput ?? createWorkflowRunDatabase(config, runtime);
  const persistence: WorkflowRunPersistence = Object.freeze({
    canRead: database.canRead,
    recovery: async (
      input: Parameters<WorkflowRunPersistence['recovery']>[0],
    ) => {
      return await database.recovery({
        ...input,
        prepareRecovery: recoveryPreparation({ catalog }),
      });
    },
    recover: async (
      input: Parameters<WorkflowRunPersistence['recover']>[0],
    ) => {
      const result = await database.recover({
        ...input,
        prepareRecovery: recoveryPreparation({ catalog }),
      });
      if (!result.replayed)
        await publishHint(notifications, {
          workspaceId: result.run.workspaceId,
          runId: result.run.id,
          sequence: 1,
        });
      return result;
    },
    usageTrends: database.usageTrends,
    usageCapacity: database.usageCapacity,
    start: (input: StartWorkflowRunCommand) =>
      executeAcceptance(database, input, catalog, notifications),
    replay: (input: ReplayWorkflowRunCommand) =>
      executeAcceptance(database, input, catalog, notifications),
    get: database.get,
    list: database.list,
    readVariables: database.readVariables,
    readInput: database.readInput,
    readNodeRunDiagnostics: database.readNodeRunDiagnostics,
    readNodeRunOutput: database.readNodeRunOutput,
    readNodeRunInput: database.readNodeRunInput,
    stepHealth: database.stepHealth,
    stepRuns: database.stepRuns,
    statistics: database.statistics,
    cancel: async (input: CancelWorkflowRunCommand) => {
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
  catalog: ReturnType<typeof composeExecutableCatalog>,
  notifications: RunEventNotificationPublisher | undefined,
): Promise<WorkflowRunAcceptanceResult> {
  const result =
    'workflowId' in input
      ? await database.start({
          ...input,
          checkpointFactory: initialCheckpointFactory({ catalog }),
        })
      : await database.replay({
          ...input,
          checkpointFactory: initialCheckpointFactory({ catalog }),
        });
  if (!result.replayed)
    await publishHint(notifications, {
      workspaceId: result.run.workspaceId,
      runId: result.run.id,
      sequence: 1,
    });
  return result;
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
