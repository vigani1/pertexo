import type { UsageTrendsInput } from '../queries/usage-trends.queries.js';
import type { UsageTrendsResponse } from '@pertexo/contracts';
import type { CodeDiagnostics } from '@pertexo/node-sdk';
import type { WorkspaceVariableSnapshot } from '@pertexo/workflow-model';
import type { InitialCheckpointFactory } from './initial-checkpoint.js';

import { z } from 'zod';

import { sha256HexSchema as digestSchema } from '../../platform/persisted-primitives.js';

import type {
  WorkflowRecoveryPreparation,
  WorkflowRecoveryPreview,
} from '../recovery/contract.js';

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

const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .refine((value) => value.slice(3, 35) !== '0'.repeat(32))
  .refine((value) => value.slice(36, 52) !== '0'.repeat(16));

const actorSchema = z.uuid();

const requestIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

export const startInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    workflowId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z
      .string()
      .regex(/^(?:workflow:[0-9a-f-]{36}:manual|api_token:[0-9a-f]{64})$/u),
    input: z.unknown().optional(),
    expectedPublishedVersionId: z.uuid().optional(),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const replayInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    sourceRunId: z.uuid(),
    workflowVersionId: z.uuid(),
    idempotencyKeyHash: digestSchema,
    requestHash: digestSchema,
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:replay$/u),
    input: z
      .unknown()
      .refine((value) => value !== undefined, 'Replay input is required'),
    deadlineAt: z.date().optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    checkpointFactory: z.custom<InitialCheckpointFactory>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const cancelInputSchema = z
  .object({
    actorId: actorSchema,
    workspaceId: z.uuid(),
    runId: z.uuid(),
    reason: z.string().trim().min(1).max(500).optional(),
    requestId: requestIdentifierSchema.optional(),
    traceId: requestIdentifierSchema.optional(),
    traceparent: traceparentSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict();

export const recoveryPreviewInputSchema = z
  .object({
    actorId: z.uuid(),
    workspaceId: z.uuid(),
    runId: z.uuid(),
    signal: z.instanceof(AbortSignal).optional(),
    prepareRecovery: z.custom<WorkflowRecoveryPreparation>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

export const recoveryInputSchema = replayInputSchema
  .omit({ input: true, checkpointFactory: true })
  .extend({
    scope: z.string().regex(/^workflow:[0-9a-f-]{36}:recover$/u),
    nodeRunId: z.uuid(),
    acknowledgePossibleEffects: z.literal(true).optional(),
    acknowledgeUnknownOutcome: z.literal(true).optional(),
    prepareRecovery: z.custom<WorkflowRecoveryPreparation>(
      (value) => typeof value === 'function',
    ),
  })
  .strict();

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
