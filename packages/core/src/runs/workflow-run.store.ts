import { lockActorArtifactReferences } from '../artifacts/references/locks.repository.js';
import {
  requireRunAccess,
  requireWorkflowAccess,
  withResourceRunRead,
  withRunCommand,
} from './access.js';
import {
  readUsageTrends,
  type UsageTrendsInput,
} from './queries/usage/trends.js';
import { acquireDatabasePool } from '@pertexo/database/platform';
import type {
  DatabaseRuntime,
  DatabaseConfig,
} from '@pertexo/database/platform';
import {
  recoverWorkflowRunInTransaction,
  allocateRecoveryIdentity,
} from './recovery/accept.repository.js';
import { readRecoveryEvidence } from './recovery/evidence.repository.js';
import {
  WorkflowRunNotFoundError,
  WorkflowPublishedVersionConflictError,
} from './errors.js';
import { replayWorkflowRunInTransaction } from './commands/replay-run.js';
import {
  readWorkflowRunListPage,
  type ListWorkflowRunsDatabaseInput,
} from './queries/history/list.repository.js';
import {
  readWorkflowStepHealth,
  readWorkflowStepRuns,
  type ReadWorkflowStepHealthInput,
  type ReadWorkflowStepRunsInput,
} from './queries/history/steps.repository.js';
import {
  readWorkflowRun,
  type GetWorkflowRunInput,
} from './queries/run.repository.js';
import {
  readWorkflowNodeRunInput,
  readWorkflowNodeRunDiagnostics,
  readWorkflowNodeRunOutput,
  readWorkflowRunInput,
  readWorkflowRunVariables,
  type ReadWorkflowNodeRunOutputInput,
  type ReadWorkflowRunInputInput,
} from './queries/history/details.repository.js';
import {
  readWorkflowRunStatistics,
  type WorkflowRunStatisticsDatabaseInput,
} from './queries/history/statistics.repository.js';
import {
  readWorkspaceUsageCapacity,
  type WorkspaceUsageCapacityInput,
} from './queries/usage/capacity.repository.js';
import type {
  WorkflowRecoveryPreviewInput,
  RecoverPublishedWorkflowRunInput,
  StartPublishedWorkflowRunInput,
  ReplayPublishedWorkflowRunInput,
  CancelWorkflowRunInput,
} from './commands/run-commands.types.js';
import { startInTransaction } from './commands/start-run.js';
import { cancelInTransaction } from './commands/cancel-run.js';

export type WorkflowRunDatabase = ReturnType<typeof createWorkflowRunDatabase>;

export function createWorkflowRunDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
) {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    canRead: async (input: GetWorkflowRunInput) =>
      (await withResourceRunRead(pool, input, () => Promise.resolve(true))) ??
      false,
    recovery: async (input: WorkflowRecoveryPreviewInput) => {
      return withResourceRunRead(pool, input, async (transaction) => {
        const evidence = await readRecoveryEvidence(transaction, {
          runId: input.runId,
          mode: 'snapshot',
          prepareRecovery: input.prepareRecovery,
        });
        if (evidence.kind === 'refused') return evidence;
        const seed = evidence.prepared.seed(
          allocateRecoveryIdentity(evidence.candidate.nodeRunIds),
        );
        return seed.kind === 'refused' ? seed : evidence.prepared.preview;
      }).then((result) => {
        if (result === undefined) throw new WorkflowRunNotFoundError();
        return result;
      });
    },
    recover: async (input: RecoverPublishedWorkflowRunInput) => {
      return withRunCommand(pool, input, 'run:replay', async (transaction) => {
        await requireRunAccess(transaction, input.sourceRunId, 'run:replay');
        return recoverWorkflowRunInTransaction(transaction, input);
      });
    },
    start: async (input: StartPublishedWorkflowRunInput) => {
      const result = await withRunCommand(
        pool,
        input,
        'run:start',
        async (transaction) => {
          await requireWorkflowAccess(
            transaction,
            input.workflowId,
            'run:start',
          );
          await lockActorArtifactReferences(
            transaction,
            input.actorId,
            input.input,
          );
          return startInTransaction(transaction, input);
        },
      );
      if ('kind' in result)
        throw new WorkflowPublishedVersionConflictError(
          result.expectedPublishedVersionId,
          result.observedPublishedVersionId,
        );
      return result;
    },
    replay: async (input: ReplayPublishedWorkflowRunInput) => {
      return withRunCommand(pool, input, 'run:replay', async (transaction) => {
        await requireRunAccess(transaction, input.sourceRunId, 'run:replay');
        return replayWorkflowRunInTransaction(transaction, input);
      });
    },
    get: (input: GetWorkflowRunInput) => readWorkflowRun(pool, input),
    list: (input: ListWorkflowRunsDatabaseInput) =>
      readWorkflowRunListPage(pool, input),
    readVariables: (input: ReadWorkflowRunInputInput) =>
      readWorkflowRunVariables(pool, input),
    readInput: (input: ReadWorkflowRunInputInput) =>
      readWorkflowRunInput(pool, input),
    readNodeRunDiagnostics: (input: ReadWorkflowNodeRunOutputInput) =>
      readWorkflowNodeRunDiagnostics(pool, input),
    readNodeRunOutput: (input: ReadWorkflowNodeRunOutputInput) =>
      readWorkflowNodeRunOutput(pool, input),
    readNodeRunInput: (input: ReadWorkflowNodeRunOutputInput) =>
      readWorkflowNodeRunInput(pool, input),
    stepHealth: (input: ReadWorkflowStepHealthInput) =>
      readWorkflowStepHealth(pool, input),
    stepRuns: (input: ReadWorkflowStepRunsInput) =>
      readWorkflowStepRuns(pool, input),
    statistics: (input: WorkflowRunStatisticsDatabaseInput) =>
      readWorkflowRunStatistics(pool, input),
    usageTrends: (input: UsageTrendsInput) => readUsageTrends(pool, input),
    usageCapacity: (input: WorkspaceUsageCapacityInput) =>
      readWorkspaceUsageCapacity(pool, input),
    cancel: async (input: CancelWorkflowRunInput) => {
      return withRunCommand(pool, input, 'run:cancel', async (transaction) => {
        await requireRunAccess(transaction, input.runId, 'run:cancel');
        return cancelInTransaction(transaction, input);
      });
    },
    close: () => lease.close(),
  });
}
