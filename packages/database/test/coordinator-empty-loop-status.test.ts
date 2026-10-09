import { expect, it } from 'vitest';
import type { PersistedWorkflowCheckpoint } from '../src/compatibility/persisted-workflow-checkpoint.js';
import {
  validateStatusTransitions,
  type ParsedTransitionPlan,
} from '../src/runs/advance/plan.js';

function emptyLoopFixture() {
  const output = {
    kind: 'inline' as const,
    attemptId: '00000000-0000-4000-8000-000000000001',
  };
  const control = {
    invocationKey: 'loop',
    nodeId: 'batch-items',
    status: 'running' as const,
    attemptNumber: 1,
    branchPath: [],
    iterationPath: [],
  };
  const current: PersistedWorkflowCheckpoint = {
    schemaVersion: 2,
    engineVersion: 'engine-v1',
    workflowVersionId: '00000000-0000-4000-8000-000000000002',
    revision: 2,
    runStatus: 'running',
    nextEventSequence: 5,
    readySet: [],
    admittedInvocationKeys: ['loop'],
    invocations: [control],
    joins: [],
    loops: [],
    remainingIterationBudget: 3,
    initialIterationBudget: 3,
    branchSelections: [],
    cancelRequested: false,
    deadlineExpired: false,
  };
  // Matches the real engine's empty declaration pass: running -> waiting ->
  // succeeded, followed by a durable immediateContinuation for the successor.
  const plan: ParsedTransitionPlan & {
    checkpoint: Extract<PersistedWorkflowCheckpoint, { schemaVersion: 2 }>;
  } = {
    expectedRevision: 2,
    expectedNextEventSequence: 5,
    consumedThroughEventSequence: 5,
    checkpoint: {
      ...current,
      revision: 3,
      nextEventSequence: 7,
      invocations: [{ ...control, status: 'succeeded', output }],
      loops: [
        {
          controlInvocationKey: 'loop',
          loopId: 'batch-items',
          branchPath: [],
          iterationPath: [],
          bodyRootNodeIds: ['body'],
          bodySinkNodeId: 'body',
          collection: output,
          collectionChecksum: 'a'.repeat(64),
          collectionSize: 0,
          maxConcurrency: 1,
          maxIterations: 3,
          nextOrdinal: 0,
          activeOrdinals: [],
          terminalOrdinals: [],
        },
      ],
    },
    events: [
      {
        schemaVersion: 1,
        sequence: 6,
        name: 'node.succeeded',
        occurredAt: '2026-10-02T00:00:00.000Z',
        invocationKey: 'loop',
        nodeId: 'batch-items',
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
    immediateContinuation: true,
  };
  const facts = [
    {
      invocationKey: 'loop',
      type: 'node.succeeded',
      observation: {
        kind: 'outcome',
        status: 'succeeded',
        attemptNumber: 1,
        output,
      },
    },
  ];
  return { current, plan, facts };
}

it('accepts an empty loop settling in the same pass as its persisted declaration outcome', () => {
  const { current, plan, facts } = emptyLoopFixture();
  expect(() => {
    validateStatusTransitions(current, plan, facts);
  }).not.toThrow();
});

it('rejects an ordinary duplicated planned terminal event', () => {
  const { current, plan, facts } = emptyLoopFixture();
  const ordinary = { ...plan, checkpoint: { ...plan.checkpoint, loops: [] } };
  expect(() => {
    validateStatusTransitions(current, ordinary, facts);
  }).toThrow();
});

it('rejects a forged nonempty loop duplicated terminal event', () => {
  const { current, plan, facts } = emptyLoopFixture();
  const nonempty = {
    ...plan,
    checkpoint: {
      ...plan.checkpoint,
      loops: plan.checkpoint.loops.map((loop) => ({
        ...loop,
        collectionSize: 1,
        nextOrdinal: 1,
        terminalOrdinals: [0],
      })),
    },
  };
  expect(() => {
    validateStatusTransitions(current, nonempty, facts);
  }).toThrow();
});

it('rejects missing persisted declaration evidence', () => {
  const { current, plan } = emptyLoopFixture();
  expect(() => {
    validateStatusTransitions(current, plan, []);
  }).toThrow();
});

it('rejects a missing derived empty-loop completion event', () => {
  const { current, plan, facts } = emptyLoopFixture();
  expect(() => {
    validateStatusTransitions(current, { ...plan, events: [] }, facts);
  }).toThrow();
});

it('rejects duplicate or unrelated derived completion events', () => {
  const { current, plan, facts } = emptyLoopFixture();
  const event = plan.events[0];
  if (event === undefined) throw new Error('Empty-loop event missing');
  for (const extra of [
    { ...event, sequence: 7 },
    { ...event, sequence: 7, invocationKey: 'unrelated', nodeId: 'other' },
  ]) {
    expect(() => {
      validateStatusTransitions(
        current,
        { ...plan, events: [...plan.events, extra] },
        facts,
      );
    }).toThrow();
  }
});

it('rejects mismatched persisted output or attempt evidence', () => {
  const { current, plan, facts } = emptyLoopFixture();
  for (const mutation of [
    { attemptNumber: 2 },
    {
      output: {
        kind: 'inline',
        attemptId: '00000000-0000-4000-8000-000000000099',
      },
    },
  ]) {
    const forged = facts.map((fact) => ({
      ...fact,
      observation: { ...fact.observation, ...mutation },
    }));
    expect(() => {
      validateStatusTransitions(current, plan, forged);
    }).toThrow();
  }
});

it('rejects a loop declaration belonging to a different control', () => {
  const { current, plan, facts } = emptyLoopFixture();
  const forged = {
    ...plan,
    checkpoint: {
      ...plan.checkpoint,
      loops: plan.checkpoint.loops.map((loop) => ({
        ...loop,
        controlInvocationKey: 'different',
      })),
    },
  };
  expect(() => {
    validateStatusTransitions(current, forged, facts);
  }).toThrow();
});

it('rejects a preexisting empty loop duplicated terminal event', () => {
  const { current, plan, facts } = emptyLoopFixture();
  expect(() => {
    validateStatusTransitions(
      { ...current, loops: plan.checkpoint.loops },
      plan,
      facts,
    );
  }).toThrow();
});
