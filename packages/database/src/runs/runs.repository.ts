import { lockActorArtifactReferences } from '../artifacts/references/repository.js';
import { withResourceRunRead } from '../tenant-access/resources/transactions.repository.js';
import {
  withRunCommand,
  requireRunAccess,
  requireWorkflowAccess,
} from './queries/access.js';
import {
  readUsageTrends,
  type UsageTrendsInput,
} from './queries/usage-trends.js';

import { acquireDatabasePool } from '../platform/pool/runtime.js';
import type { DatabaseRuntime } from '../platform/pool/runtime.js';

import type { DatabaseConfig } from '../config.js';

import {
  recoverWorkflowRunInTransaction,
  allocateRecoveryIdentity,
} from './recovery/accept.js';
import {
  readRecoveryMetadata,
  readRecoveryValues,
} from './recovery/queries.js';

import {
  WorkflowRunNotFoundError,
  WorkflowPublishedVersionConflictError,
} from './errors.js';

import { replayWorkflowRunInTransaction } from './commands/replay.js';
import {
  readWorkflowRunListPage,
  type ListWorkflowRunsDatabaseInput,
} from './queries/history/list.js';
import {
  readWorkflowStepHealth,
  readWorkflowStepRuns,
  type ReadWorkflowStepHealthInput,
  type ReadWorkflowStepRunsInput,
} from './queries/history/steps.js';
import { readWorkflowRun, type GetWorkflowRunInput } from './queries/read.js';
import {
  readWorkflowNodeRunInput,
  readWorkflowNodeRunDiagnostics,
  readWorkflowNodeRunOutput,
  readWorkflowRunInput,
  readWorkflowRunVariables,
  type ReadWorkflowNodeRunOutputInput,
  type ReadWorkflowRunInputInput,
} from './queries/history/details.js';
import {
  readWorkflowRunStatistics,
  type WorkflowRunStatisticsDatabaseInput,
} from './queries/history/statistics.js';
import {
  readWorkspaceUsageCapacity,
  type WorkspaceUsageCapacityInput,
} from './queries/usage-capacity.js';
import {
  startInputSchema,
  replayInputSchema,
  cancelInputSchema,
  recoveryPreviewInputSchema,
  recoveryInputSchema,
  type WorkflowRecoveryPreviewInput,
  type RecoverPublishedWorkflowRunInput,
  type StartPublishedWorkflowRunInput,
  type ReplayPublishedWorkflowRunInput,
  type CancelWorkflowRunInput,
  type WorkflowRunDatabase,
} from './commands/contract.js';
import { startInTransaction } from './commands/start.js';
import { cancelInTransaction } from './commands/cancel-active.js';
export {
  WorkflowRunNotExecutableError,
  WorkflowRunNotFoundError,
  WorkflowRunReadCapacityError,
  WorkflowPublishedVersionConflictError,
} from './errors.js';
export type { WorkflowRunRecord } from './commands/records.js';
export type {
  GetWorkflowRunInput,
  WorkflowNodeRunRecord,
  WorkflowRunReadModel,
} from './queries/read.js';
export {
  type WorkflowRecoveryPreviewInput,
  type RecoverPublishedWorkflowRunInput,
  type StartPublishedWorkflowRunInput,
  type ReplayPublishedWorkflowRunInput,
  type CancelWorkflowRunInput,
  type WorkflowRunDatabase,
} from './commands/contract.js';
export {
  requestActiveRunCancellations,
  cancelInTransaction,
} from './commands/cancel-active.js';
export function createWorkflowRunDatabase(
  config: DatabaseConfig,
  runtime?: DatabaseRuntime,
): WorkflowRunDatabase {
  const lease = acquireDatabasePool(config, runtime);
  const { pool } = lease;
  return Object.freeze({
    canRead: async (input: Parameters<WorkflowRunDatabase['canRead']>[0]) =>
      (await withResourceRunRead(pool, input, () => Promise.resolve(true))) ??
      false,
    recovery: async (input: WorkflowRecoveryPreviewInput) => {
      const parsed = recoveryPreviewInputSchema.parse(input);
      return withResourceRunRead(pool, parsed, async (transaction) => {
        const metadata = await readRecoveryMetadata(
          transaction,
          parsed.runId,
          'snapshot',
        );
        if ('kind' in metadata) return metadata;
        const candidate = parsed.prepareRecovery(metadata);
        if (candidate.kind === 'refused') return candidate;
        const values = await readRecoveryValues(
          transaction,
          parsed.runId,
          candidate.nodeRunIds,
        );
        if ('kind' in values) return values;
        const prepared = candidate.complete(values);
        if (prepared.kind === 'refused') return prepared;
        const seed = prepared.seed(
          allocateRecoveryIdentity(candidate.nodeRunIds),
        );
        return seed.kind === 'refused' ? seed : prepared.preview;
      }).then((result) => {
        if (result === undefined) throw new WorkflowRunNotFoundError();
        return result;
      });
    },
    recover: async (input: RecoverPublishedWorkflowRunInput) => {
      const parsed = recoveryInputSchema.parse(input);
      return withRunCommand(pool, parsed, 'run:replay', async (transaction) => {
        await requireRunAccess(transaction, parsed.sourceRunId, 'run:replay');
        return recoverWorkflowRunInTransaction(transaction, parsed);
      });
    },
    start: async (input: StartPublishedWorkflowRunInput) => {
      const parsed = startInputSchema.parse(input);
      const result = await withRunCommand(
        pool,
        parsed,
        'run:start',
        async (transaction) => {
          await requireWorkflowAccess(
            transaction,
            parsed.workflowId,
            'run:start',
          );
          await lockActorArtifactReferences(
            transaction,
            parsed.actorId,
            parsed.input,
          );
          return startInTransaction(transaction, parsed);
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
      const parsed = replayInputSchema.parse(input);
      return withRunCommand(pool, parsed, 'run:replay', async (transaction) => {
        await requireRunAccess(transaction, parsed.sourceRunId, 'run:replay');
        return replayWorkflowRunInTransaction(transaction, parsed);
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
      const parsed = cancelInputSchema.parse(input);
      return withRunCommand(pool, parsed, 'run:cancel', async (transaction) => {
        await requireRunAccess(transaction, parsed.runId, 'run:cancel');
        return cancelInTransaction(transaction, parsed);
      });
    },
    close: () => lease.close(),
  });
}
