import type { startInputSchema } from './input.js';
import type { replayInputSchema } from './input.js';
import type { cancelInputSchema } from './input.js';
import type { recoveryPreviewInputSchema } from './input.js';
import type { recoveryInputSchema } from './input.js';
import type { UsageTrendsInput } from '../queries/usage-trends.queries.js';
import type { UsageTrendsResponse } from '@pertexo/contracts';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';

import type { z } from 'zod';

import type { WorkflowRecoveryPreview } from '../recovery/contract.js';

import type { WorkflowRunRecord } from './records.repository.js';

import type {
  ListWorkflowRunsDatabaseInput,
  WorkflowRunListPage,
} from '../queries/history/list.queries.js';
import type {
  ReadWorkflowStepHealthInput,
  ReadWorkflowStepRunsInput,
  WorkflowStepHealthPage,
  WorkflowStepRunRecord,
} from '../queries/history/steps.queries.js';
import type {
  GetWorkflowRunInput,
  WorkflowRunReadModel,
} from '../queries/read.queries.js';
import type {
  ReadWorkflowNodeRunOutputInput,
  ReadWorkflowRunInputInput,
  WorkflowRunData,
} from '../queries/history/details.queries.js';
import type {
  WorkflowRunStatisticsDatabaseInput,
  WorkflowRunStatisticsRecord,
} from '../queries/history/statistics.queries.js';
import type {
  WorkspaceUsageCapacityInput,
  WorkspaceUsageCapacityRecord,
} from '../queries/usage-capacity.queries.js';

export type WorkflowRecoveryPreviewInput = Readonly<
  z.input<typeof recoveryPreviewInputSchema>
>;

export type RecoverPublishedWorkflowRunInput = Readonly<
  z.input<typeof recoveryInputSchema>
>;

export type StartPublishedWorkflowRunInput = Readonly<
  z.input<typeof startInputSchema>
>;

export type ReplayPublishedWorkflowRunInput = Readonly<
  z.input<typeof replayInputSchema>
>;

export type CancelWorkflowRunInput = Readonly<
  z.input<typeof cancelInputSchema>
>;

export interface WorkflowRunDatabase {
  canRead(
    input: Readonly<{
      workspaceId: string;
      actorId: string;
      runId: string;
      signal?: AbortSignal | undefined;
    }>,
  ): Promise<boolean>;

  usageTrends(input: UsageTrendsInput): Promise<UsageTrendsResponse>;
  recovery(
    input: WorkflowRecoveryPreviewInput,
  ): Promise<WorkflowRecoveryPreview>;
  recover(
    input: RecoverPublishedWorkflowRunInput,
  ): Promise<Readonly<{ run: WorkflowRunRecord; replayed: boolean }>>;
  usageCapacity(
    input: WorkspaceUsageCapacityInput,
  ): Promise<WorkspaceUsageCapacityRecord>;
  start(input: StartPublishedWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  replay(input: ReplayPublishedWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      replayed: boolean;
    }>
  >;
  get(input: GetWorkflowRunInput): Promise<WorkflowRunReadModel | undefined>;
  list(input: ListWorkflowRunsDatabaseInput): Promise<WorkflowRunListPage>;
  readVariables(
    input: ReadWorkflowRunInputInput,
  ): Promise<WorkspaceVariableSnapshot | null | undefined>;
  readInput(
    input: ReadWorkflowRunInputInput,
  ): Promise<WorkflowRunData | undefined>;
  readNodeRunDiagnostics(
    input: ReadWorkflowNodeRunOutputInput,
  ): Promise<CodeDiagnostics | null | undefined>;
  readNodeRunOutput(
    input: ReadWorkflowNodeRunOutputInput,
  ): Promise<WorkflowRunData | undefined>;
  readNodeRunInput(
    input: ReadWorkflowNodeRunOutputInput,
  ): Promise<WorkflowRunData | undefined>;
  stepHealth(
    input: ReadWorkflowStepHealthInput,
  ): Promise<WorkflowStepHealthPage | undefined>;
  stepRuns(
    input: ReadWorkflowStepRunsInput,
  ): Promise<readonly WorkflowStepRunRecord[] | undefined>;
  statistics(
    input: WorkflowRunStatisticsDatabaseInput,
  ): Promise<WorkflowRunStatisticsRecord>;
  cancel(input: CancelWorkflowRunInput): Promise<
    Readonly<{
      run: WorkflowRunRecord;
      alreadyRequested: boolean;
      eventSequence: number | null;
    }>
  >;
  close(): Promise<void>;
}
