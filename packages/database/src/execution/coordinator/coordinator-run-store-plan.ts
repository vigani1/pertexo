import { createHash } from 'node:crypto';

import { z } from 'zod';

import {
  CoordinatorPlanInvalidError,
  coordinatorIdentitySchema as identitySchema,
} from './coordinator-run-store-contract.js';
import {
  normalizeCoordinatorPlan,
  coordinatorPlanFingerprintJson,
} from './coordinator-plan-values.js';
import {
  assertTransitionPlanValid,
  invocationScope,
  sameKeys,
} from './coordinator-run-store-plan-validation.js';
import { assertStatusTransitionsValid } from './coordinator-run-store-status-validation.js';
import {
  parseCoordinatorCheckpoint,
  type CoordinatorCheckpoint as PersistedWorkflowCheckpoint,
} from './coordinator-checkpoint.js';
import {
  persistedWorkflowCallStateSchemaV1,
  type PersistedWorkflowCallStateV1,
} from '../../compatibility/persisted-workflow-checkpoint-v3.js';
import { serializeStoredExecutionJsonValue } from '../stored-execution-value.js';

export { validateCheckpointOutputOwnership } from './coordinator-checkpoint-output-ownership.js';

export const scheduleRunInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    triggerId: identitySchema,
    nodeId: z.string().trim().min(1).max(128),
    scheduledAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const sideEffectClassSchema = z.enum(['safe', 'idempotent_with_key', 'unsafe']);
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
const nodeRunAdmissionSchema = z
  .object({
    invocationKey: z.string().min(1).max(256),
    nodeId: z.string().min(1).max(128),
    providerIdempotencyKey: z.string().min(1).max(256).optional(),
    sideEffectClass: sideEffectClassSchema,
    branchPath: z.array(branchScopePartSchema).max(1_000).optional(),
    iterationPath: z.array(iterationScopePartSchema).max(1_000).optional(),
  })
  .strict();
const attemptAdmissionSchema = nodeRunAdmissionSchema
  .extend({
    attemptNumber: z.number().int().positive(),
    admissionKind: z
      .enum(['execute', 'retry', 'wait_resume'])
      .default('execute'),
  })
  .strict();
const engineEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().positive(),
    name: z.enum([
      'run.started',
      'run.cancel_requested',
      'run.waiting',
      'run.succeeded',
      'run.failed',
      'run.canceled',
      'run.timed_out',
      'run.outcome_unknown',
      'node.ready',
      'node.waiting',
      'node.retry_scheduled',
      'node.succeeded',
      'node.failed',
      'node.skipped',
      'node.canceled',
      'node.timed_out',
      'node.outcome_unknown',
    ]),
    occurredAt: z.iso.datetime(),
    invocationKey: z.string().min(1).max(256).optional(),
    nodeId: z.string().min(1).max(128).optional(),
    attemptNumber: z.number().int().nonnegative().optional(),
    reasonCode: z.string().min(1).max(128).optional(),
    dueAt: z.iso.datetime().optional(),
  })
  .strict();
const transitionPlanSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    expectedNextEventSequence: z.number().int().positive(),
    consumedThroughEventSequence: z.number().int().nonnegative(),
    checkpoint: z.unknown(),
    events: z.array(engineEventSchema).max(512),
    nodeRunAdmissions: z.array(nodeRunAdmissionSchema).max(10_000),
    attempts: z.array(attemptAdmissionSchema).max(64),
    immediateContinuation: z.literal(true).optional(),
    workflowCalls: z
      .object({
        declarations: z.array(persistedWorkflowCallStateSchemaV1).max(64),
        cancelChildren: z
          .array(
            z
              .object({
                childRunId: identitySchema,
                reason: z.enum(['cancel_requested', 'deadline_expired']),
              })
              .strict(),
          )
          .max(64),
      })
      .strict()
      .optional(),
    callableResult: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('failed'),
            reasonCode: z.enum([
              'workflow.child_result_invalid',
              'workflow.child_result_missing',
            ]),
          })
          .strict(),
        z
          .object({
            kind: z.literal('succeeded'),
            value: z.record(z.string(), z.unknown()),
            sources: z
              .array(
                z
                  .object({
                    invocationKey: z.string().min(1).max(256),
                    output: z.discriminatedUnion('kind', [
                      z
                        .object({
                          kind: z.literal('inline'),
                          attemptId: identitySchema,
                        })
                        .strict(),
                      z
                        .object({
                          kind: z.literal('artifact'),
                          artifactId: identitySchema,
                        })
                        .strict(),
                      z
                        .object({
                          kind: z.literal('workflow_call'),
                          invocationKey: z.string().min(1).max(256),
                          childRunId: identitySchema,
                        })
                        .strict(),
                    ]),
                  })
                  .strict(),
              )
              .max(10_000),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();

export type ParsedTransitionPlan = Omit<
  z.output<typeof transitionPlanSchema>,
  'checkpoint'
> & { readonly checkpoint: PersistedWorkflowCheckpoint };

export function parseTransitionPlan(value: unknown): ParsedTransitionPlan {
  try {
    const parsed = transitionPlanSchema.parse(normalizeCoordinatorPlan(value));
    const checkpointFields = z
      .object({ schemaVersion: z.number() })
      .loose()
      .parse(parsed.checkpoint);
    const checkpoint = parseCoordinatorCheckpoint(
      parsed.checkpoint,
      checkpointFields.schemaVersion === 3 ? 3 : 2,
    );
    if (
      checkpoint.schemaVersion !== 3 &&
      (parsed.workflowCalls !== undefined ||
        parsed.callableResult !== undefined)
    )
      throw new CoordinatorPlanInvalidError();
    return Object.freeze({
      ...parsed,
      checkpoint,
    });
  } catch {
    throw new CoordinatorPlanInvalidError();
  }
}

export function validateTransitionPlan(
  plan: ParsedTransitionPlan,
  workflowVersionId: string,
): void {
  assertTransitionPlanValid(plan, workflowVersionId);
}

export function transitionFingerprint(
  input: Readonly<{
    plan: ParsedTransitionPlan;
    traceparent: string | undefined;
    workflowVersionId: string;
  }>,
): string {
  return createHash('sha256')
    .update(
      serializeStoredExecutionJsonValue({
        schemaVersion: 1,
        workflowVersionId: input.workflowVersionId,
        plan: JSON.parse(coordinatorPlanFingerprintJson(input.plan)) as unknown,
        traceparent: input.traceparent ?? null,
      }),
    )
    .digest('hex');
}

export function validateTransitionDelta(
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
): void {
  if (current.schemaVersion !== plan.checkpoint.schemaVersion)
    throw new CoordinatorPlanInvalidError();
  if (current.schemaVersion === 3 && plan.checkpoint.schemaVersion === 3) {
    const nextCalls = plan.checkpoint.calls;
    const currentCalls = new Set(
      current.calls.map(({ invocationKey }) => invocationKey),
    );
    const declaredCalls = plan.checkpoint.calls.filter(
      ({ invocationKey }) => !currentCalls.has(invocationKey),
    );
    const declarations = plan.workflowCalls?.declarations ?? [];
    if (
      current.calls.some(
        ({ invocationKey }) =>
          !nextCalls.some((call) => call.invocationKey === invocationKey),
      ) ||
      new Set(declarations.map(({ invocationKey }) => invocationKey)).size !==
        declarations.length ||
      declaredCalls.length !== declarations.length ||
      declarations.some(
        (call) =>
          !declaredCalls.some(
            (declared) =>
              serializeStoredExecutionJsonValue(declared) ===
              serializeStoredExecutionJsonValue(call),
          ),
      )
    )
      throw new CoordinatorPlanInvalidError();
  }
  const expectedAdmittedKeys = new Set([
    ...current.admittedInvocationKeys,
    ...plan.attempts.map(({ invocationKey }) => invocationKey),
  ]);
  const currentLoops = new Map(
    current.loops.map((loop) => [loop.controlInvocationKey, loop]),
  );
  const declaredLoops = plan.checkpoint.loops.filter(
    (loop) => !currentLoops.has(loop.controlInvocationKey),
  );
  const reservedIterations = declaredLoops.reduce(
    (total, loop) => total + loop.collectionSize,
    0,
  );
  if (
    plan.checkpoint.engineVersion !== current.engineVersion ||
    plan.checkpoint.remainingIterationBudget !==
      current.remainingIterationBudget - reservedIterations ||
    ('initialIterationBudget' in current &&
      current.initialIterationBudget !== undefined &&
      (!('initialIterationBudget' in plan.checkpoint) ||
        plan.checkpoint.initialIterationBudget !==
          current.initialIterationBudget)) ||
    !sameKeys(
      expectedAdmittedKeys,
      new Set(plan.checkpoint.admittedInvocationKeys),
    )
  )
    throw new CoordinatorPlanInvalidError();
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  for (const nextLoop of plan.checkpoint.loops) {
    const previous = currentLoops.get(nextLoop.controlInvocationKey);
    if (previous === undefined) continue;
    const immutable = (loop: typeof nextLoop): unknown => ({
      controlInvocationKey: loop.controlInvocationKey,
      loopId: loop.loopId,
      branchPath: loop.branchPath,
      iterationPath: loop.iterationPath,
      bodyRootNodeIds: loop.bodyRootNodeIds,
      bodySinkNodeId: loop.bodySinkNodeId,
      collection: loop.collection,
      collectionChecksum: loop.collectionChecksum,
      collectionSize: loop.collectionSize,
      maxConcurrency: loop.maxConcurrency,
      maxIterations: loop.maxIterations,
    });
    if (
      serializeStoredExecutionJsonValue(immutable(previous)) !==
      serializeStoredExecutionJsonValue(immutable(nextLoop))
    )
      throw new CoordinatorPlanInvalidError();
  }
  const nextInvocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const scopedInvocations = new Map<
    string,
    (typeof current.invocations)[number]
  >();
  for (const invocation of nextInvocations.values()) {
    const key = serializeStoredExecutionJsonValue([
      invocation.nodeId,
      invocationScope(invocation, 'branchPath'),
      invocationScope(invocation, 'iterationPath'),
    ]);
    // Array.find previously selected the first matching checkpoint entry.
    if (!scopedInvocations.has(key)) scopedInvocations.set(key, invocation);
  }
  for (const loop of plan.checkpoint.loops) {
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      for (const rootNodeId of loop.bodyRootNodeIds) {
        const root = scopedInvocations.get(
          serializeStoredExecutionJsonValue([
            rootNodeId,
            loop.branchPath,
            iterationPath,
          ]),
        );
        if (
          root === undefined ||
          !['ready', 'running', 'waiting', 'succeeded', 'skipped'].includes(
            root.status,
          )
        )
          throw new CoordinatorPlanInvalidError();
      }
    }
  }
  const expectedNodeRunAdmissions = new Set(
    [...nextInvocations.keys()].filter((key) => !currentInvocations.has(key)),
  );
  const actualNodeRunAdmissions = new Set(
    plan.nodeRunAdmissions.map(({ invocationKey }) => invocationKey),
  );
  if (!sameKeys(expectedNodeRunAdmissions, actualNodeRunAdmissions))
    throw new CoordinatorPlanInvalidError();

  const expectedAttempts = new Set<string>();
  for (const [key, next] of nextInvocations) {
    const previous = currentInvocations.get(key);
    if (next.status !== 'running' || previous?.status === 'running') continue;
    const expectedAttemptNumber =
      previous === undefined ? 1 : previous.attemptNumber + 1;
    if (
      (previous !== undefined &&
        previous.status !== 'pending' &&
        previous.status !== 'ready' &&
        previous.status !== 'waiting') ||
      next.attemptNumber !== expectedAttemptNumber
    )
      throw new CoordinatorPlanInvalidError();
    expectedAttempts.add(key);
  }
  const actualAttempts = new Set(
    plan.attempts.map(({ invocationKey }) => invocationKey),
  );
  if (!sameKeys(expectedAttempts, actualAttempts))
    throw new CoordinatorPlanInvalidError();
}

export function validateStatusTransitions(
  current: PersistedWorkflowCheckpoint,
  plan: ParsedTransitionPlan,
  persistedFacts: readonly Readonly<{
    invocationKey: string | null;
    observation: Readonly<Record<string, unknown>>;
    type: string;
  }>[],
  rejectedForEachDeclarations: ReadonlySet<string> = new Set(),
  callFacts: readonly PersistedWorkflowCallStateV1[] = [],
  stoppedForEachDeclarations: ReadonlySet<string> = new Set(),
): void {
  assertStatusTransitionsValid(
    current,
    plan,
    persistedFacts,
    terminalRunStatuses,
    rejectedForEachDeclarations,
    callFacts,
    stoppedForEachDeclarations,
  );
}

export const terminalRunStatuses = new Set([
  'succeeded',
  'failed',
  'canceled',
  'timed_out',
  'outcome_unknown',
]);
export const allowedRunTransitions: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  queued: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  running: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
  waiting: new Set([
    'running',
    'waiting',
    'succeeded',
    'failed',
    'canceled',
    'timed_out',
    'outcome_unknown',
  ]),
};
