import { z } from 'zod';

import { serializeStoredExecutionJsonValue } from '../execution/stored-execution-value.js';
import {
  refineBranchSelections,
  refineInvocationScopes,
  refineJoinScopes,
  refineLoopsBudgetAndWaits,
} from './persisted-workflow-checkpoint-refinements.js';

export const PERSISTED_WORKFLOW_CHECKPOINT_LIMITS = Object.freeze({
  readySet: 10_000,
  admittedInvocationKeys: 10_000,
  invocations: 10_000,
  joins: 1_000,
  loops: 1_000,
  branchSelections: 10_000,
  scopeParts: 1_000,
  invocationKeyBytes: 256,
});

const canonicalUuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
const outputReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('inline'), attemptId: canonicalUuidSchema })
    .strict(),
  z
    .object({ kind: z.literal('artifact'), artifactId: canonicalUuidSchema })
    .strict(),
]);
const invocationShape = {
  invocationKey: z
    .string()
    .min(1)
    .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocationKeyBytes),
  nodeId: z.string().min(1).max(128),
  status: z.enum([
    'pending',
    'ready',
    'running',
    'waiting',
    'succeeded',
    'failed',
    'skipped',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  attemptNumber: z.number().int().nonnegative(),
  resumeAt: z.iso.datetime().optional(),
  waitKind: z.enum(['node_wait', 'retry_backoff']).optional(),
  output: outputReferenceSchema.optional(),
} as const;
const invocationSchemaV1 = z.object(invocationShape).strict();
const branchScopePartSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    outputPort: z.string().min(1).max(128),
  })
  .strict();
const iterationScopePartSchema = z
  .object({
    loopNodeId: z.string().min(1).max(128),
    ordinal: z.number().int().nonnegative(),
  })
  .strict();
const invocationSchemaV2 = z
  .object({
    ...invocationShape,
    branchPath: z
      .array(branchScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts)
      .optional(),
    iterationPath: z
      .array(iterationScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts)
      .optional(),
  })
  .strict()
  .superRefine((invocation, context) => {
    if (
      invocation.branchPath !== undefined &&
      new Set(invocation.branchPath.map(({ nodeId }) => nodeId)).size !==
        invocation.branchPath.length
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint branch scope is inconsistent',
      });
  });
const branchSelectionSchema = z
  .object({
    invocationKey: z
      .string()
      .min(1)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocationKeyBytes),
    nodeId: z.string().min(1).max(128),
    selectedOutputPort: z.string().min(1).max(128),
  })
  .strict();
const branchLedgerEntrySchema = z
  .object({
    branchId: z.string().min(1).max(128),
    disposition: z.enum([
      'pending',
      'arrived',
      'skipped',
      'missing',
      'failed',
      'canceled',
    ]),
    output: outputReferenceSchema.optional(),
  })
  .strict();
const joinPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('any') }).strict(),
  z
    .object({ kind: z.literal('count'), count: z.number().int().positive() })
    .strict(),
]);
const joinSchema = z
  .object({
    joinInvocationKey: z
      .string()
      .min(1)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocationKeyBytes)
      .optional(),
    joinId: z.string().min(1).max(128),
    branchPath: z
      .array(branchScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts)
      .optional(),
    iterationPath: z
      .array(iterationScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts)
      .optional(),
    policy: joinPolicySchema,
    ledger: z.array(branchLedgerEntrySchema).min(1).max(16),
    selectedBranchIds: z.array(z.string().min(1).max(128)).max(16).optional(),
    unsatisfiedReasonCode: z
      .enum(['branch_failed', 'branch_canceled', 'insufficient_arrivals'])
      .optional(),
  })
  .strict();
const loopSchema = z
  .object({
    controlInvocationKey: z
      .string()
      .min(1)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocationKeyBytes),
    loopId: z.string().min(1).max(128),
    branchPath: z
      .array(branchScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
    iterationPath: z
      .array(iterationScopePartSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
    bodyRootNodeIds: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
    bodySinkNodeId: z.string().min(1).max(128),
    terminalStatus: z
      .enum(['failed', 'canceled', 'timed_out', 'outcome_unknown'])
      .optional(),
    collection: outputReferenceSchema,
    collectionChecksum: z.string().min(1).max(256),
    collectionSize: z.number().int().nonnegative(),
    maxConcurrency: z.number().int().positive(),
    maxIterations: z.number().int().positive(),
    nextOrdinal: z.number().int().nonnegative(),
    activeOrdinals: z
      .array(z.number().int().nonnegative())
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
    terminalOrdinals: z
      .array(z.number().int().nonnegative())
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.scopeParts),
  })
  .strict()
  .superRefine((loop, context) => {
    const active = [...loop.activeOrdinals].sort((left, right) => left - right);
    const terminal = [...loop.terminalOrdinals].sort(
      (left, right) => left - right,
    );
    const admitted = [...active, ...terminal].sort(
      (left, right) => left - right,
    );
    if (
      loop.maxConcurrency > loop.maxIterations ||
      loop.collectionSize > loop.maxIterations ||
      loop.nextOrdinal > loop.collectionSize ||
      active.length > loop.maxConcurrency ||
      new Set(loop.bodyRootNodeIds).size !== loop.bodyRootNodeIds.length ||
      new Set(admitted).size !== admitted.length ||
      admitted.length !== loop.nextOrdinal ||
      admitted.some(
        (ordinal, index) => ordinal !== index || ordinal >= loop.collectionSize,
      )
    )
      context.addIssue({
        code: 'custom',
        message: 'checkpoint loop state is inconsistent',
      });
  })
  .transform((loop) => ({
    ...loop,
    bodyRootNodeIds: [...loop.bodyRootNodeIds].sort(compareOrdinal),
    activeOrdinals: [...loop.activeOrdinals].sort(
      (left, right) => left - right,
    ),
    terminalOrdinals: [...loop.terminalOrdinals].sort(
      (left, right) => left - right,
    ),
  }));

const checkpointShape = {
  engineVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u),
  workflowVersionId: canonicalUuidSchema,
  revision: z.number().int().nonnegative(),
  runStatus: z.enum([
    'queued',
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  nextEventSequence: z.number().int().positive(),
  readySet: z
    .array(z.string().min(1).max(256))
    .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.readySet),
  admittedInvocationKeys: z
    .array(z.string().min(1).max(256))
    .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.admittedInvocationKeys),
  joins: z.array(joinSchema).max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.joins),
  remainingIterationBudget: z.number().int().nonnegative(),
  cancelRequested: z.boolean(),
  deadlineExpired: z.boolean(),
} as const;

function refineInvocationIndexes(
  checkpoint: {
    readonly readySet: readonly string[];
    readonly admittedInvocationKeys: readonly string[];
    readonly invocations: readonly z.output<typeof invocationSchemaV1>[];
  },
  context: z.RefinementCtx,
): void {
  const invocations = new Map(
    checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const readySet = [...invocations.values()]
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey)
    .sort();
  const persistedReady = [...checkpoint.readySet].sort();
  if (
    invocations.size !== checkpoint.invocations.length ||
    new Set(checkpoint.readySet).size !== checkpoint.readySet.length ||
    new Set(checkpoint.admittedInvocationKeys).size !==
      checkpoint.admittedInvocationKeys.length ||
    persistedReady.some((key, index) => readySet[index] !== key) ||
    readySet.length !== persistedReady.length ||
    checkpoint.admittedInvocationKeys.some((key) => !invocations.has(key))
  )
    context.addIssue({
      code: 'custom',
      message: 'checkpoint invocation indexes are inconsistent',
    });
}

const persistedWorkflowCheckpointV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...checkpointShape,
    loops: z.array(z.never()).max(0),
    invocations: z
      .array(invocationSchemaV1)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocations),
  })
  .strict()
  .superRefine(refineInvocationIndexes);

const persistedWorkflowCheckpointV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...checkpointShape,
    loops: z.array(loopSchema).max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.loops),
    invocations: z
      .array(invocationSchemaV2)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.invocations),
    branchSelections: z
      .array(branchSelectionSchema)
      .max(PERSISTED_WORKFLOW_CHECKPOINT_LIMITS.branchSelections),
    initialIterationBudget: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    refineInvocationIndexes(checkpoint, context);
    const invocations = new Map(
      checkpoint.invocations.map((invocation) => [
        invocation.invocationKey,
        invocation,
      ]),
    );
    refineBranchSelections(checkpoint, invocations, context);
    refineInvocationScopes(checkpoint, context);
    refineJoinScopes(checkpoint, invocations, context);
    refineLoopsBudgetAndWaits(checkpoint, invocations, context);
  })
  .transform((checkpoint) => {
    const selections = new Map<
      string,
      z.output<typeof branchSelectionSchema>
    >();
    for (const selection of checkpoint.branchSelections)
      selections.set(
        `${selection.invocationKey}\u0000${selection.nodeId}`,
        selection,
      );
    return {
      ...checkpoint,
      branchSelections: [...selections.values()].sort(
        (left, right) =>
          compareOrdinal(left.invocationKey, right.invocationKey) ||
          compareOrdinal(left.nodeId, right.nodeId),
      ),
    };
  });

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type PersistedWorkflowCheckpoint = Readonly<
  | z.output<typeof persistedWorkflowCheckpointV1Schema>
  | z.output<typeof persistedWorkflowCheckpointV2Schema>
>;

class PersistedWorkflowCheckpointInvalidError extends Error {
  public override readonly name = 'PersistedWorkflowCheckpointInvalidError';
  public constructor() {
    super('Persisted workflow checkpoint is invalid');
  }
}

export function parsePersistedWorkflowCheckpoint(
  value: unknown,
): PersistedWorkflowCheckpoint {
  try {
    const normalized = JSON.parse(
      serializeStoredExecutionJsonValue(value),
    ) as unknown;
    if (
      typeof normalized !== 'object' ||
      normalized === null ||
      !('schemaVersion' in normalized)
    )
      throw new PersistedWorkflowCheckpointInvalidError();
    return Object.freeze(
      normalized.schemaVersion === 1
        ? persistedWorkflowCheckpointV1Schema.parse(normalized)
        : persistedWorkflowCheckpointV2Schema.parse(normalized),
    );
  } catch {
    throw new PersistedWorkflowCheckpointInvalidError();
  }
}

export function parseInitialWorkflowCheckpoint(
  value: unknown,
  identity: Readonly<{ engineVersion: string; workflowVersionId: string }>,
): PersistedWorkflowCheckpoint {
  const checkpoint = parsePersistedWorkflowCheckpoint(value);
  if (
    checkpoint.engineVersion !== identity.engineVersion ||
    checkpoint.workflowVersionId !== identity.workflowVersionId ||
    checkpoint.revision !== 0 ||
    checkpoint.runStatus !== 'queued' ||
    checkpoint.nextEventSequence !== 2 ||
    checkpoint.readySet.length !== 0 ||
    checkpoint.admittedInvocationKeys.length !== 0 ||
    checkpoint.invocations.length !== 0 ||
    checkpoint.joins.length !== 0 ||
    checkpoint.loops.length !== 0 ||
    checkpoint.remainingIterationBudget < 0 ||
    checkpoint.cancelRequested ||
    checkpoint.deadlineExpired
  )
    throw new PersistedWorkflowCheckpointInvalidError();
  return checkpoint;
}

export function serializePersistedWorkflowCheckpoint(value: unknown): string {
  return serializeStoredExecutionJsonValue(
    parsePersistedWorkflowCheckpoint(value),
  );
}
