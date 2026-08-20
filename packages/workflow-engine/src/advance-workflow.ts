import { parseCheckpoint, reconstructReadySet } from './checkpoint.js';
import { WorkflowEngineError } from './errors.js';
import { deriveReadyNodes, type SchedulerGraph } from './graph-scheduler.js';
import { assertNodeTransition, assertRunTransition } from './transitions.js';
import type {
  AttemptAdmissionPlan,
  EngineEventName,
  EngineEventPlan,
  InvocationState,
  NodeStatus,
  OutputReference,
  WorkflowCheckpointV1,
  WorkflowTransitionPlan,
} from './types.js';

export type WorkflowObservation =
  | {
      readonly kind: 'ready';
      readonly invocationKey: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: 'outcome';
      readonly invocationKey: string;
      readonly status: Extract<
        NodeStatus,
        | 'succeeded'
        | 'failed'
        | 'canceled'
        | 'timed_out'
        | 'outcome_unknown'
        | 'skipped'
      >;
      readonly output?: OutputReference;
      readonly reasonCode?: string;
    }
  | {
      readonly kind: 'wait';
      readonly invocationKey: string;
      readonly resumeAt: string;
    }
  | { readonly kind: 'resume'; readonly invocationKey: string }
  | { readonly kind: 'cancel_requested' };

export interface AdvanceWorkflowInput {
  readonly checkpoint: WorkflowCheckpointV1;
  readonly graph?: SchedulerGraph;
  readonly observations?: readonly WorkflowObservation[];
  readonly occurredAt: string;
  readonly maximumAdmissions: number;
}

const nodeEventName: Readonly<Partial<Record<NodeStatus, EngineEventName>>> = {
  ready: 'node.ready',
  waiting: 'node.waiting',
  succeeded: 'node.succeeded',
  failed: 'node.failed',
  skipped: 'node.skipped',
  canceled: 'node.canceled',
  timed_out: 'node.timed_out',
  outcome_unknown: 'node.outcome_unknown',
};

export function advanceWorkflow(
  input: AdvanceWorkflowInput,
): WorkflowTransitionPlan {
  if (
    !Number.isSafeInteger(input.maximumAdmissions) ||
    input.maximumAdmissions < 0
  ) {
    throw new WorkflowEngineError(
      'checkpoint_invalid',
      'maximumAdmissions must be non-negative',
    );
  }
  const current = parseCheckpoint(input.checkpoint);
  const invocations = new Map(
    current.invocations.map((invocation) => [
      invocation.invocationKey,
      invocation,
    ]),
  );
  const eventDrafts: Omit<EngineEventPlan, 'sequence'>[] = [];
  let cancelRequested = current.cancelRequested;
  let runStatus = current.runStatus;

  if (runStatus === 'queued') {
    assertRunTransition(runStatus, 'running');
    runStatus = 'running';
    eventDrafts.push(event('run.started', input.occurredAt));
  }

  if (
    input.graph !== undefined &&
    !cancelRequested &&
    (runStatus === 'running' || runStatus === 'waiting')
  ) {
    for (const decision of deriveReadyNodes({
      graph: input.graph,
      workflowVersionId: current.workflowVersionId,
      invocations: [...invocations.values()],
    })) {
      const invocation: InvocationState = {
        invocationKey: decision.invocationKey,
        nodeId: decision.nodeId,
        status: decision.disposition,
        attemptNumber: 0,
      };
      invocations.set(invocation.invocationKey, invocation);
      eventDrafts.push(
        event(
          decision.disposition === 'ready' ? 'node.ready' : 'node.skipped',
          input.occurredAt,
          invocation,
        ),
      );
    }
  }

  const observations = [...(input.observations ?? [])].sort(observationOrder);
  for (const observation of observations) {
    if (observation.kind === 'cancel_requested') {
      if (!cancelRequested)
        eventDrafts.push(event('run.cancel_requested', input.occurredAt));
      cancelRequested = true;
      continue;
    }
    const existing = invocations.get(observation.invocationKey);
    if (observation.kind === 'ready') {
      if (cancelRequested || existing !== undefined) continue;
      const ready: InvocationState = {
        invocationKey: observation.invocationKey,
        nodeId: observation.nodeId,
        status: 'ready',
        attemptNumber: 0,
      };
      invocations.set(observation.invocationKey, ready);
      eventDrafts.push(event('node.ready', input.occurredAt, ready));
      continue;
    }
    if (existing === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `unknown invocation ${observation.invocationKey}`,
      );
    }
    if (observation.kind === 'wait') {
      assertNodeTransition(existing.status, 'waiting');
      invocations.set(existing.invocationKey, {
        ...existing,
        status: 'waiting',
        resumeAt: observation.resumeAt,
      });
      eventDrafts.push(event('node.waiting', input.occurredAt, existing));
      continue;
    }
    if (observation.kind === 'resume') {
      assertNodeTransition(existing.status, 'ready');
      const { resumeAt: _, ...rest } = existing;
      void _;
      const resumed = { ...rest, status: 'ready' as const };
      invocations.set(existing.invocationKey, resumed);
      eventDrafts.push(event('node.ready', input.occurredAt, resumed));
      if (runStatus === 'waiting') {
        assertRunTransition(runStatus, 'running');
        runStatus = 'running';
      }
      continue;
    }
    assertNodeTransition(existing.status, observation.status);
    const completed: InvocationState = {
      ...existing,
      status: observation.status,
      ...(observation.output === undefined
        ? {}
        : { output: observation.output }),
    };
    invocations.set(existing.invocationKey, completed);
    const eventName = nodeEventName[observation.status];
    if (eventName === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `missing event mapping for ${observation.status}`,
      );
    }
    eventDrafts.push(
      event(eventName, input.occurredAt, completed, observation.reasonCode),
    );
  }

  const ordered = [...invocations.values()].sort((left, right) =>
    left.invocationKey.localeCompare(right.invocationKey),
  );
  const readySet = ordered
    .filter(({ status }) => status === 'ready')
    .map(({ invocationKey }) => invocationKey);
  const admittedKeys = readySet.slice(0, input.maximumAdmissions);
  const attempts: AttemptAdmissionPlan[] = [];
  for (const key of admittedKeys) {
    const invocation = invocations.get(key);
    if (invocation === undefined) {
      throw new WorkflowEngineError(
        'checkpoint_invalid',
        `ready invocation ${key} is missing`,
      );
    }
    assertNodeTransition(invocation.status, 'running');
    const running = {
      ...invocation,
      status: 'running' as const,
      attemptNumber: invocation.attemptNumber + 1,
    };
    invocations.set(key, running);
    attempts.push({
      invocationKey: key,
      nodeId: running.nodeId,
      attemptNumber: running.attemptNumber,
    });
  }

  const finalInvocations = [...invocations.values()].sort((left, right) =>
    left.invocationKey.localeCompare(right.invocationKey),
  );
  const nonterminal = finalInvocations.filter(({ status }) =>
    ['pending', 'ready', 'running', 'waiting'].includes(status),
  );
  const graphIncomplete =
    input.graph?.nodes.some(
      ({ id }) => !finalInvocations.some(({ nodeId }) => nodeId === id),
    ) === true;
  if (
    finalInvocations.some(({ status }) => status === 'outcome_unknown') &&
    runStatus === 'running'
  ) {
    assertRunTransition(runStatus, 'outcome_unknown');
    runStatus = 'outcome_unknown';
    eventDrafts.push(event('run.outcome_unknown', input.occurredAt));
  } else if (
    cancelRequested &&
    nonterminal.length === 0 &&
    runStatus === 'running'
  ) {
    assertRunTransition(runStatus, 'canceled');
    runStatus = 'canceled';
    eventDrafts.push(event('run.canceled', input.occurredAt));
  } else if (
    finalInvocations.some(({ status }) => status === 'failed') &&
    runStatus === 'running'
  ) {
    assertRunTransition(runStatus, 'failed');
    runStatus = 'failed';
    eventDrafts.push(event('run.failed', input.occurredAt));
  } else if (
    finalInvocations.length > 0 &&
    nonterminal.length === 0 &&
    !graphIncomplete &&
    runStatus === 'running'
  ) {
    assertRunTransition(runStatus, 'succeeded');
    runStatus = 'succeeded';
    eventDrafts.push(event('run.succeeded', input.occurredAt));
  } else if (
    runStatus === 'running' &&
    finalInvocations.length > 0 &&
    finalInvocations.every(({ status }) => status === 'waiting')
  ) {
    assertRunTransition(runStatus, 'waiting');
    runStatus = 'waiting';
    eventDrafts.push(event('run.waiting', input.occurredAt));
  }

  const events = eventDrafts.map((draft, offset) => ({
    ...draft,
    sequence: current.nextEventSequence + offset,
  }));
  const checkpoint = parseCheckpoint({
    ...current,
    revision: current.revision + 1,
    runStatus,
    nextEventSequence: current.nextEventSequence + events.length,
    cancelRequested,
    admittedInvocationKeys: [
      ...new Set([...current.admittedInvocationKeys, ...admittedKeys]),
    ].sort(),
    invocations: finalInvocations,
    readySet: reconstructReadySet({
      ...current,
      invocations: finalInvocations,
    }),
  });
  return { expectedRevision: current.revision, checkpoint, events, attempts };
}

function observationOrder(
  left: WorkflowObservation,
  right: WorkflowObservation,
): number {
  const leftKey = left.kind === 'cancel_requested' ? '' : left.invocationKey;
  const rightKey = right.kind === 'cancel_requested' ? '' : right.invocationKey;
  return leftKey.localeCompare(rightKey) || left.kind.localeCompare(right.kind);
}

function event(
  name: EngineEventName,
  occurredAt: string,
  invocation?: InvocationState,
  reasonCode?: string,
): Omit<EngineEventPlan, 'sequence'> {
  return {
    schemaVersion: 1,
    name,
    occurredAt,
    ...(invocation === undefined
      ? {}
      : {
          invocationKey: invocation.invocationKey,
          nodeId: invocation.nodeId,
          attemptNumber: invocation.attemptNumber,
        }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
  };
}
