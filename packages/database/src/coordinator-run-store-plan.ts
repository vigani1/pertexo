import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';
import { z } from 'zod';

import {
  CoordinatorPlanInvalidError,
  CoordinatorRunStateCorruptError,
  coordinatorIdentitySchema as identitySchema,
} from './coordinator-run-store-contract.js';
import {
  normalizedJson,
  terminalStatus,
} from './coordinator-run-store-observations.js';
import {
  assertTransitionPlanValid,
  invocationScope,
  sameKeys,
} from './coordinator-run-store-plan-validation.js';
import {
  parsePersistedPhase3Checkpoint,
  type PersistedPhase3Checkpoint,
} from './phase3-checkpoint.js';
import {
  parseStoredExecutionValueV1,
  serializeStoredExecutionJsonValue,
} from './stored-execution-value.js';

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
  })
  .strict();
export const traceparentSchema = z
  .string()
  .regex(/^00-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/u)
  .optional();

export type ParsedTransitionPlan = Omit<
  z.output<typeof transitionPlanSchema>,
  'checkpoint'
> & { readonly checkpoint: PersistedPhase3Checkpoint };

export function parseTransitionPlan(value: unknown): ParsedTransitionPlan {
  try {
    const parsed = transitionPlanSchema.parse(normalizedJson(value));
    return Object.freeze({
      ...parsed,
      checkpoint: parsePersistedPhase3Checkpoint(parsed.checkpoint),
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
        plan: input.plan,
        traceparent: input.traceparent ?? null,
      }),
    )
    .digest('hex');
}

export function validateTransitionDelta(
  current: PersistedPhase3Checkpoint,
  plan: ParsedTransitionPlan,
): void {
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
  for (const loop of plan.checkpoint.loops) {
    for (const ordinal of loop.activeOrdinals) {
      const iterationPath = [
        ...loop.iterationPath,
        { loopNodeId: loop.loopId, ordinal },
      ];
      for (const rootNodeId of loop.bodyRootNodeIds) {
        const root = [...nextInvocations.values()].find(
          (invocation) =>
            invocation.nodeId === rootNodeId &&
            serializeStoredExecutionJsonValue(
              invocationScope(invocation, 'branchPath'),
            ) === serializeStoredExecutionJsonValue(loop.branchPath) &&
            serializeStoredExecutionJsonValue(
              invocationScope(invocation, 'iterationPath'),
            ) === serializeStoredExecutionJsonValue(iterationPath),
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
  current: PersistedPhase3Checkpoint,
  plan: ParsedTransitionPlan,
  persistedFacts: readonly Readonly<{
    invocationKey: string | null;
    observation: Readonly<Record<string, unknown>>;
    type: string;
  }>[],
): void {
  const currentInvocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const plannedNodeEvents = new Set(
    plan.events.flatMap((event) =>
      event.invocationKey === undefined
        ? []
        : [`${event.invocationKey}:${event.name}`],
    ),
  );
  const expectedNodeEvents = new Set<string>();
  const persistedNodeFacts = new Set<string>();
  const persistedByInvocation = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  for (const fact of persistedFacts) {
    if (fact.type.startsWith('node.') && fact.invocationKey === null)
      throw new CoordinatorRunStateCorruptError();
    if (fact.invocationKey !== null) {
      persistedNodeFacts.add(`${fact.invocationKey}:${fact.type}`);
      persistedByInvocation.set(fact.invocationKey, fact.observation);
    }
  }
  const nextInvocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  if (
    current.invocations.some(
      ({ invocationKey }) => !nextInvocations.has(invocationKey),
    )
  )
    throw new CoordinatorPlanInvalidError();
  for (const fact of persistedFacts) {
    if (fact.invocationKey === null) continue;
    const next = nextInvocations.get(fact.invocationKey);
    const kind = fact.observation.kind;
    if (kind === 'wait') {
      if (next?.status !== 'waiting') throw new CoordinatorPlanInvalidError();
      if (
        next.attemptNumber !== fact.observation.attemptNumber ||
        next.resumeAt !== fact.observation.resumeAt
      )
        throw new CoordinatorPlanInvalidError();
    } else if (kind === 'outcome') {
      if (next === undefined) throw new CoordinatorPlanInvalidError();
      const declaredLoopBarrier =
        next.status === 'waiting' &&
        next.resumeAt === undefined &&
        fact.observation.status === 'succeeded' &&
        plan.checkpoint.loops.some(
          ({ controlInvocationKey }) =>
            controlInvocationKey === next.invocationKey &&
            !current.loops.some(
              (loop) => loop.controlInvocationKey === controlInvocationKey,
            ),
        );
      if (next.status !== fact.observation.status && !declaredLoopBarrier)
        throw new CoordinatorPlanInvalidError();
      if (
        next.attemptNumber !== fact.observation.attemptNumber ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(fact.observation.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
    }
  }
  for (const next of plan.checkpoint.invocations) {
    const previous = currentInvocations.get(next.invocationKey);
    if (previous === undefined) {
      if (
        next.status === 'pending' &&
        plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId)
      )
        continue;
      const eventName =
        next.status === 'skipped' ? 'node.skipped' : 'node.ready';
      expectedNodeEvents.add(`${next.invocationKey}:${eventName}`);
      if (!plannedNodeEvents.has(`${next.invocationKey}:${eventName}`))
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (previous.nodeId !== next.nodeId)
      throw new CoordinatorPlanInvalidError();
    if (previous.status === next.status) {
      if (
        serializeStoredExecutionJsonValue(previous) !==
        serializeStoredExecutionJsonValue(next)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    const terminalEvent = `node.${next.status}`;
    if (previous.status === 'waiting' && next.status === 'ready') {
      expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        !plannedNodeEvents.has(`${next.invocationKey}:node.ready`) ||
        next.attemptNumber !== previous.attemptNumber ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      previous.status === 'pending' &&
      next.status === 'running' &&
      plan.checkpoint.joins.some(({ joinId }) => joinId === next.nodeId)
    ) {
      expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        !plannedNodeEvents.has(`${next.invocationKey}:node.ready`) ||
        next.attemptNumber !== previous.attemptNumber + 1
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      (previous.status === 'ready' || previous.status === 'waiting') &&
      next.status === 'running'
    ) {
      if (previous.status === 'waiting')
        expectedNodeEvents.add(`${next.invocationKey}:node.ready`);
      if (
        next.attemptNumber !== previous.attemptNumber + 1 ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    if (
      previous.status === 'running' &&
      (next.status === 'waiting' || terminalStatus(terminalEvent) !== undefined)
    ) {
      const pending = persistedByInvocation.get(next.invocationKey);
      if (pending?.kind === 'attempt_failure') {
        const expectedEvent =
          next.status === 'waiting' ? 'node.retry_scheduled' : terminalEvent;
        expectedNodeEvents.add(`${next.invocationKey}:${expectedEvent}`);
        if (
          !plannedNodeEvents.has(`${next.invocationKey}:${expectedEvent}`) ||
          next.attemptNumber !== previous.attemptNumber ||
          (next.status === 'waiting' &&
            (next.resumeAt === undefined ||
              plan.events.find(
                (event) =>
                  event.invocationKey === next.invocationKey &&
                  event.name === expectedEvent,
              )?.dueAt !== next.resumeAt))
        )
          throw new CoordinatorPlanInvalidError();
        continue;
      }
      const sourceNames =
        next.status === 'waiting'
          ? ['node.waiting', 'node.retry_scheduled']
          : [terminalEvent];
      const observation = persistedByInvocation.get(next.invocationKey);
      const declaredLoopBarrier = plan.checkpoint.loops.some(
        ({ controlInvocationKey }) =>
          controlInvocationKey === next.invocationKey &&
          !current.loops.some(
            (loop) => loop.controlInvocationKey === controlInvocationKey,
          ),
      );
      if (
        declaredLoopBarrier &&
        next.status === 'waiting' &&
        next.resumeAt === undefined &&
        observation?.kind === 'outcome' &&
        observation.status === 'succeeded' &&
        next.attemptNumber === previous.attemptNumber &&
        serializeStoredExecutionJsonValue(next.output ?? null) ===
          serializeStoredExecutionJsonValue(observation.output ?? null)
      )
        continue;
      if (
        sourceNames.some((name) =>
          persistedNodeFacts.has(`${next.invocationKey}:${name}`),
        ) &&
        observation !== undefined &&
        next.attemptNumber === previous.attemptNumber &&
        (next.status !== 'waiting' || next.resumeAt === observation.resumeAt) &&
        (next.status === 'waiting' ||
          (observation.status === next.status &&
            serializeStoredExecutionJsonValue(next.output ?? null) ===
              serializeStoredExecutionJsonValue(observation.output ?? null)))
      )
        continue;
    } else if (
      (previous.status === 'ready' || previous.status === 'waiting') &&
      terminalStatus(terminalEvent) !== undefined &&
      plannedNodeEvents.has(`${next.invocationKey}:${terminalEvent}`)
    ) {
      expectedNodeEvents.add(`${next.invocationKey}:${terminalEvent}`);
      if (
        next.attemptNumber !== previous.attemptNumber ||
        next.resumeAt !== undefined ||
        serializeStoredExecutionJsonValue(next.output ?? null) !==
          serializeStoredExecutionJsonValue(previous.output ?? null)
      )
        throw new CoordinatorPlanInvalidError();
      continue;
    }
    throw new CoordinatorPlanInvalidError();
  }

  const plannedNodeEventCount = plan.events.filter(({ name }) =>
    name.startsWith('node.'),
  ).length;
  if (
    plannedNodeEventCount !== expectedNodeEvents.size ||
    !sameKeys(plannedNodeEvents, expectedNodeEvents)
  )
    throw new CoordinatorPlanInvalidError();

  const expectedRunEvents = new Set<string>();
  if (
    current.runStatus === 'queued' &&
    plan.checkpoint.runStatus !== 'canceled' &&
    plan.checkpoint.runStatus !== 'timed_out'
  )
    expectedRunEvents.add('run.started');
  if (
    current.runStatus !== 'waiting' &&
    plan.checkpoint.runStatus === 'waiting'
  )
    expectedRunEvents.add('run.waiting');
  if (terminalRunStatuses.has(plan.checkpoint.runStatus))
    expectedRunEvents.add(`run.${plan.checkpoint.runStatus}`);
  const plannedRunEvents = plan.events.filter(({ name }) =>
    name.startsWith('run.'),
  );
  if (
    plannedRunEvents.length !== expectedRunEvents.size ||
    plannedRunEvents.some(({ name }) => !expectedRunEvents.has(name))
  )
    throw new CoordinatorPlanInvalidError();
}

export async function validateCheckpointOutputOwnership(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  checkpoint: PersistedPhase3Checkpoint,
  waitResumeKeys: ReadonlySet<string>,
): Promise<void> {
  const expected = checkpoint.invocations.filter(
    (invocation) => invocation.output !== undefined,
  );
  if (expected.length === 0) return;
  const rows = await client.query<{
    attempt_id: string | null;
    attempt_output_ref: unknown;
    attempt_status: string | null;
    control_kind: string | null;
    invocation_key: string;
    node_output_ref: unknown;
    node_status: string;
  }>(
    `select node.invocation_key, node.status as node_status,node.control_kind,
            node.output_ref as node_output_ref,
            attempt.id as attempt_id, attempt.status as attempt_status,
            attempt.output_ref as attempt_output_ref
     from app.node_runs node
     join app.node_attempts attempt
       on attempt.workspace_id=node.workspace_id
      and attempt.id=node.current_attempt_id
     where node.workspace_id=$1 and node.workflow_run_id=$2
       and node.invocation_key=any($3::varchar[])
     for share of node, attempt`,
    [workspaceId, runId, expected.map(({ invocationKey }) => invocationKey)],
  );
  const physical = new Map(rows.rows.map((row) => [row.invocation_key, row]));
  const artifacts = new Set<string>();
  for (const invocation of expected) {
    const row = physical.get(invocation.invocationKey);
    const isLoopControl = checkpoint.loops.some(
      ({ controlInvocationKey }) =>
        controlInvocationKey === invocation.invocationKey,
    );
    const physicalLoopStatus =
      isLoopControl && row?.control_kind === 'for_each_barrier'
        ? 'waiting'
        : 'succeeded';
    const isSuspendedNodeWait =
      invocation.status === 'waiting' && invocation.waitKind === 'node_wait';
    const isWaitResume =
      invocation.status === 'running' &&
      invocation.waitKind === undefined &&
      waitResumeKeys.has(invocation.invocationKey);
    const expectedNodeStatus =
      isSuspendedNodeWait || isWaitResume
        ? 'waiting'
        : isLoopControl
          ? physicalLoopStatus
          : invocation.status;
    const expectedAttemptStatus =
      isSuspendedNodeWait || isWaitResume || isLoopControl
        ? 'succeeded'
        : invocation.status;
    if (
      row?.attempt_id === undefined ||
      row.attempt_id === null ||
      row.node_status !== expectedNodeStatus ||
      row.attempt_status !== expectedAttemptStatus
    )
      throw new CoordinatorRunStateCorruptError();
    let nodeValue;
    let attemptValue;
    try {
      nodeValue = parseStoredExecutionValueV1(row.node_output_ref);
      attemptValue = parseStoredExecutionValueV1(row.attempt_output_ref);
    } catch {
      throw new CoordinatorRunStateCorruptError();
    }
    if (
      serializeStoredExecutionJsonValue(nodeValue) !==
      serializeStoredExecutionJsonValue(attemptValue)
    )
      throw new CoordinatorRunStateCorruptError();
    const output = invocation.output;
    if (output === undefined) throw new CoordinatorRunStateCorruptError();
    if (output.kind === 'inline') {
      if (output.attemptId !== row.attempt_id || nodeValue.kind !== 'inline')
        throw new CoordinatorRunStateCorruptError();
    } else {
      if (
        nodeValue.kind !== 'artifact' ||
        nodeValue.artifactId !== output.artifactId
      )
        throw new CoordinatorRunStateCorruptError();
      artifacts.add(output.artifactId);
    }
  }
  if (artifacts.size === 0) return;
  const available = await client.query<{ id: string }>(
    `select id from app.artifacts
     where workspace_id=$1 and id=any($2::uuid[])
       and status='available' and deleted_at is null
     for share`,
    [workspaceId, [...artifacts]],
  );
  if (available.rows.length !== artifacts.size)
    throw new CoordinatorRunStateCorruptError();
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
