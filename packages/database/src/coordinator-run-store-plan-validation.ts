import type { ParsedTransitionPlan } from './coordinator-run-store-plan.js';
import type { PersistedPhase3Checkpoint } from './phase3-checkpoint.js';
import {
  assertPlan,
  sameStoredValue,
} from './coordinator-run-store-validation-values.js';

type CheckpointInvocation = PersistedPhase3Checkpoint['invocations'][number];
type Attempt = ParsedTransitionPlan['attempts'][number];
type Admission = ParsedTransitionPlan['nodeRunAdmissions'][number];
type EngineEvent = ParsedTransitionPlan['events'][number];

export function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((key) => right.has(key));
}

export function invocationScope(
  invocation: CheckpointInvocation | undefined,
  field: 'branchPath' | 'iterationPath',
): readonly unknown[] {
  if (invocation === undefined || !(field in invocation)) return [];
  return (
    (
      invocation as Readonly<
        Record<'branchPath' | 'iterationPath', readonly unknown[] | undefined>
      >
    )[field] ?? []
  );
}

function validatePlanEnvelope(
  plan: ParsedTransitionPlan,
  workflowVersionId: string,
): void {
  const firstDerivedSequence = plan.consumedThroughEventSequence + 1;
  assertPlan(plan.expectedNextEventSequence <= firstDerivedSequence);
  assertPlan(plan.checkpoint.revision === plan.expectedRevision + 1);
  assertPlan(plan.checkpoint.workflowVersionId === workflowVersionId);
  assertPlan(
    plan.checkpoint.nextEventSequence ===
      firstDerivedSequence + plan.events.length,
  );
  assertPlan(
    plan.events.every(
      ({ sequence }, index) => sequence === firstDerivedSequence + index,
    ),
  );
  assertPlan(plan.events.every(({ name }) => name !== 'run.cancel_requested'));
  assertPlan(
    !plan.checkpoint.cancelRequested && !plan.checkpoint.deadlineExpired
      ? true
      : plan.attempts.length === 0 && plan.nodeRunAdmissions.length === 0,
  );
}

function validateAttempt(
  attempt: Attempt,
  invocation: CheckpointInvocation | undefined,
  materialized: Admission | undefined,
  admittedInvocationKeys: ReadonlySet<string>,
): void {
  assertPlan(
    (attempt.sideEffectClass === 'idempotent_with_key') ===
      (attempt.providerIdempotencyKey !== undefined),
  );
  assertPlan(invocation !== undefined);
  assertPlan(invocation.nodeId === attempt.nodeId);
  assertPlan(invocation.status === 'running');
  assertPlan(invocation.attemptNumber === attempt.attemptNumber);
  assertPlan(admittedInvocationKeys.has(attempt.invocationKey));
  if (materialized === undefined) return;
  assertPlan(materialized.nodeId === attempt.nodeId);
  assertPlan(materialized.sideEffectClass === attempt.sideEffectClass);
  assertPlan(
    materialized.providerIdempotencyKey === attempt.providerIdempotencyKey,
  );
  assertPlan(
    sameStoredValue(materialized.branchPath ?? [], attempt.branchPath ?? []),
  );
  assertPlan(
    sameStoredValue(
      materialized.iterationPath ?? [],
      attempt.iterationPath ?? [],
    ),
  );
}

function validateAttempts(
  plan: ParsedTransitionPlan,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  nodeAdmissions: ReadonlyMap<string, Admission>,
): ReadonlySet<string> {
  const attemptKeys = new Set<string>();
  const admittedInvocationKeys = new Set(
    plan.checkpoint.admittedInvocationKeys,
  );
  for (const attempt of plan.attempts) {
    assertPlan(!attemptKeys.has(attempt.invocationKey));
    validateAttempt(
      attempt,
      invocations.get(attempt.invocationKey),
      nodeAdmissions.get(attempt.invocationKey),
      admittedInvocationKeys,
    );
    attemptKeys.add(attempt.invocationKey);
  }
  return attemptKeys;
}

function validateAdmission(
  admission: Admission,
  invocation: CheckpointInvocation | undefined,
  hasAttempt: boolean,
): void {
  assertPlan(
    (admission.sideEffectClass === 'idempotent_with_key') ===
      (admission.providerIdempotencyKey !== undefined),
  );
  assertPlan(invocation !== undefined);
  assertPlan(invocation.nodeId === admission.nodeId);
  assertPlan(
    sameStoredValue(
      invocationScope(invocation, 'branchPath'),
      admission.branchPath ?? [],
    ),
  );
  assertPlan(
    sameStoredValue(
      invocationScope(invocation, 'iterationPath'),
      admission.iterationPath ?? [],
    ),
  );
  assertPlan(
    invocation.status === 'pending' ||
      invocation.status === 'ready' ||
      invocation.status === 'running' ||
      invocation.status === 'skipped',
  );
  assertPlan((invocation.status === 'running') === hasAttempt);
}

function validateAdmissions(
  plan: ParsedTransitionPlan,
  invocations: ReadonlyMap<string, CheckpointInvocation>,
  attemptKeys: ReadonlySet<string>,
): void {
  for (const admission of plan.nodeRunAdmissions) {
    validateAdmission(
      admission,
      invocations.get(admission.invocationKey),
      attemptKeys.has(admission.invocationKey),
    );
  }
}

function validateEvent(
  event: EngineEvent,
  invocation: CheckpointInvocation | undefined,
  hasAttempt: boolean,
): void {
  const isNodeEvent = event.name.startsWith('node.');
  if (!isNodeEvent) {
    assertPlan(event.invocationKey === undefined && event.nodeId === undefined);
    return;
  }
  assertPlan(event.invocationKey !== undefined && event.nodeId !== undefined);
  assertPlan(invocation !== undefined);
  const expectedAttemptNumber =
    event.name === 'node.ready' && invocation.status === 'running' && hasAttempt
      ? invocation.attemptNumber - 1
      : invocation.attemptNumber;
  assertPlan(invocation.nodeId === event.nodeId);
  assertPlan(event.attemptNumber === expectedAttemptNumber);
  assertPlan(
    (event.name === 'node.retry_scheduled') === (event.dueAt !== undefined),
  );
  if (event.name === 'node.retry_scheduled') {
    assertPlan(event.dueAt === invocation.resumeAt);
    assertPlan(invocation.waitKind === 'retry_backoff');
  }
  if (event.name === 'node.waiting') {
    assertPlan(invocation.waitKind === 'node_wait');
  }
}

export function assertTransitionPlanValid(
  plan: ParsedTransitionPlan,
  workflowVersionId: string,
): void {
  validatePlanEnvelope(plan, workflowVersionId);
  const invocations = new Map(
    plan.checkpoint.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  assertPlan(invocations.size === plan.checkpoint.invocations.length);
  assertPlan(
    new Set(plan.checkpoint.admittedInvocationKeys).size ===
      plan.checkpoint.admittedInvocationKeys.length,
  );
  const nodeAdmissions = new Map(
    plan.nodeRunAdmissions.map((admission) => [
      admission.invocationKey,
      admission,
    ]),
  );
  assertPlan(nodeAdmissions.size === plan.nodeRunAdmissions.length);
  const attemptKeys = validateAttempts(plan, invocations, nodeAdmissions);
  validateAdmissions(plan, invocations, attemptKeys);
  for (const event of plan.events) {
    validateEvent(
      event,
      event.invocationKey === undefined
        ? undefined
        : invocations.get(event.invocationKey),
      event.invocationKey !== undefined && attemptKeys.has(event.invocationKey),
    );
  }
}
