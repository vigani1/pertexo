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
} from '@pertexo/core/execution';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';

import type {
  CancelWorkflowRunCommand,
  ReplayWorkflowRunCommand,
  StartWorkflowRunCommand,
  WorkflowRunPersistence,
} from './ports.js';

import type { RunEventNotificationPublisher } from './events/index.js';

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
    canRead: (input: Parameters<WorkflowRunPersistence['canRead']>[0]) =>
      database.canRead(input),
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
    usageTrends: async (
      input: Parameters<WorkflowRunPersistence['usageTrends']>[0],
    ) => {
      return await database.usageTrends(input);
    },
    usageCapacity: async (
      input: Parameters<WorkflowRunPersistence['usageCapacity']>[0],
    ) => {
      return await database.usageCapacity(input);
    },
    start: (input: StartWorkflowRunCommand) =>
      executeAcceptance(database, input, catalog, notifications),
    replay: (input: ReplayWorkflowRunCommand) =>
      executeAcceptance(database, input, catalog, notifications),
    get: async (input: Parameters<WorkflowRunPersistence['get']>[0]) => {
      return await database.get(input);
    },
    list: async (input: Parameters<WorkflowRunPersistence['list']>[0]) => {
      return await database.list(input);
    },
    readVariables: async (
      input: Parameters<WorkflowRunPersistence['readVariables']>[0],
    ) => {
      return await database.readVariables(input);
    },
    readInput: async (
      input: Parameters<WorkflowRunPersistence['readInput']>[0],
    ) => {
      return await database.readInput(input);
    },
    readNodeRunDiagnostics: async (
      input: Parameters<WorkflowRunPersistence['readNodeRunDiagnostics']>[0],
    ) => {
      return await database.readNodeRunDiagnostics(input);
    },
    readNodeRunOutput: async (
      input: Parameters<WorkflowRunPersistence['readNodeRunOutput']>[0],
    ) => {
      return await database.readNodeRunOutput(input);
    },
    readNodeRunInput: async (
      input: Parameters<WorkflowRunPersistence['readNodeRunInput']>[0],
    ) => {
      return await database.readNodeRunInput(input);
    },
    stepHealth: async (
      input: Parameters<WorkflowRunPersistence['stepHealth']>[0],
    ) => {
      return await database.stepHealth(input);
    },
    stepRuns: async (
      input: Parameters<WorkflowRunPersistence['stepRuns']>[0],
    ) => {
      return await database.stepRuns(input);
    },
    statistics: async (
      input: Parameters<WorkflowRunPersistence['statistics']>[0],
    ) => {
      return await database.statistics(input);
    },
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
