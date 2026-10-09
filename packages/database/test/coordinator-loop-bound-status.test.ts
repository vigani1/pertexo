import { expect, it } from 'vitest';
import type { PersistedWorkflowCheckpoint } from '../src/compatibility/persisted-workflow-checkpoint.js';
import {
  validateStatusTransitions,
  type ParsedTransitionPlan,
} from '../src/runs/advance/plan.js';

// Exact minimized real engine shape; a safe acceptance additionally needs
// independently loaded executable bounds + current physical attempt output.
it('accepts the independently proven loop-bound failure after executor declaration success', () => {
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
    remainingIterationBudget: 10,
    initialIterationBudget: 10,
    branchSelections: [],
    cancelRequested: false,
    deadlineExpired: false,
  };
  const plan: ParsedTransitionPlan = {
    expectedRevision: 2,
    expectedNextEventSequence: 5,
    consumedThroughEventSequence: 5,
    checkpoint: {
      ...current,
      revision: 3,
      nextEventSequence: 8,
      runStatus: 'failed',
      invocations: [{ ...control, status: 'failed' }],
    },
    events: [
      {
        schemaVersion: 1,
        sequence: 6,
        name: 'node.failed',
        occurredAt: '2026-10-02T00:00:00.000Z',
        invocationKey: 'loop',
        nodeId: 'batch-items',
        reasonCode: 'loop_limit_exceeded',
      },
      {
        schemaVersion: 1,
        sequence: 7,
        name: 'run.failed',
        occurredAt: '2026-10-02T00:00:00.000Z',
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
  };
  const facts = [
    {
      invocationKey: 'loop',
      type: 'node.succeeded',
      observation: {
        kind: 'outcome',
        status: 'succeeded',
        attemptNumber: 1,
        output: {
          kind: 'inline',
          attemptId: '00000000-0000-4000-8000-000000000001',
        },
      },
    },
  ];
  expect(() => {
    validateStatusTransitions(current, plan, facts);
  }).toThrow();
  expect(() => {
    validateStatusTransitions(current, plan, facts, new Set(['loop']));
  }).not.toThrow();
});
