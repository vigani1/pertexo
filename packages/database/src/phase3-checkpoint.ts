import { z } from 'zod';

import { serializeStoredExecutionJsonValue } from './stored-execution-value.js';

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
  invocationKey: z.string().min(1).max(256),
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
  output: outputReferenceSchema.optional(),
} as const;
const invocationSchemaV1 = z.object(invocationShape).strict();
const branchScopePartSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    outputPort: z.string().min(1).max(128),
  })
  .strict();
const invocationSchemaV2 = z
  .object({
    ...invocationShape,
    branchPath: z.array(branchScopePartSchema).max(1_000).optional(),
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
    invocationKey: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(128),
    selectedOutputPort: z.string().min(1).max(128),
  })
  .strict();
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
  readySet: z.array(z.string().min(1).max(256)).max(10_000),
  admittedInvocationKeys: z.array(z.string().min(1).max(256)).max(10_000),
  joins: z.array(z.never()).max(0),
  loops: z.array(z.never()).max(0),
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

const phase3CheckpointV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    ...checkpointShape,
    invocations: z.array(invocationSchemaV1).max(10_000),
  })
  .strict()
  .superRefine(refineInvocationIndexes);

const phase3CheckpointV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    ...checkpointShape,
    invocations: z.array(invocationSchemaV2).max(10_000),
    branchSelections: z.array(branchSelectionSchema).max(10_000),
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
    const selections = new Map<string, string>();
    for (const selection of checkpoint.branchSelections) {
      const invocation = invocations.get(selection.invocationKey);
      const key = `${selection.invocationKey}\u0000${selection.nodeId}`;
      const existing = selections.get(key);
      if (
        invocation?.nodeId !== selection.nodeId ||
        invocation.status !== 'succeeded' ||
        invocation.output === undefined ||
        (existing !== undefined && existing !== selection.selectedOutputPort)
      )
        context.addIssue({
          code: 'custom',
          message: 'checkpoint branch selection is inconsistent',
        });
      selections.set(key, selection.selectedOutputPort);
    }
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

export type PersistedPhase3Checkpoint = Readonly<
  | z.output<typeof phase3CheckpointV1Schema>
  | z.output<typeof phase3CheckpointV2Schema>
>;

export class Phase3CheckpointInvalidError extends Error {
  public override readonly name = 'Phase3CheckpointInvalidError';
  public constructor() {
    super('Phase 3 workflow checkpoint is invalid');
  }
}

export function parsePersistedPhase3Checkpoint(
  value: unknown,
): PersistedPhase3Checkpoint {
  try {
    const normalized = JSON.parse(
      serializeStoredExecutionJsonValue(value),
    ) as unknown;
    if (
      typeof normalized !== 'object' ||
      normalized === null ||
      !('schemaVersion' in normalized)
    )
      throw new Phase3CheckpointInvalidError();
    return Object.freeze(
      normalized.schemaVersion === 1
        ? phase3CheckpointV1Schema.parse(normalized)
        : phase3CheckpointV2Schema.parse(normalized),
    );
  } catch {
    throw new Phase3CheckpointInvalidError();
  }
}

export function parseInitialPhase3Checkpoint(
  value: unknown,
  identity: Readonly<{ engineVersion: string; workflowVersionId: string }>,
): PersistedPhase3Checkpoint {
  const checkpoint = parsePersistedPhase3Checkpoint(value);
  if (
    checkpoint.engineVersion !== identity.engineVersion ||
    checkpoint.workflowVersionId !== identity.workflowVersionId ||
    checkpoint.revision !== 0 ||
    checkpoint.runStatus !== 'queued' ||
    checkpoint.nextEventSequence !== 2 ||
    checkpoint.readySet.length !== 0 ||
    checkpoint.admittedInvocationKeys.length !== 0 ||
    checkpoint.invocations.length !== 0 ||
    checkpoint.remainingIterationBudget < 0 ||
    checkpoint.cancelRequested ||
    checkpoint.deadlineExpired
  )
    throw new Phase3CheckpointInvalidError();
  return checkpoint;
}

export function serializePersistedPhase3Checkpoint(value: unknown): string {
  return serializeStoredExecutionJsonValue(
    parsePersistedPhase3Checkpoint(value),
  );
}
