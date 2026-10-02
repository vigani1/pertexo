import { expect, it } from 'vitest';
import { workflowForEachBoundsV2 } from '@pertexo/workflow-model/graph';
import { encodeWorkflowInvocationKeyV2 } from '@pertexo/workflow-model/invocation-key-v2';
import type { PersistedWorkflowCheckpoint } from '../src/compatibility/persisted-workflow-checkpoint.js';
import type { CoordinatorEventRow } from '../src/execution/coordinator/coordinator-run-store-fact-physical-state.js';
import type { ParsedTransitionPlan } from '../src/execution/coordinator/coordinator-run-store-plan.js';
import { CoordinatorPlanInvalidError } from '../src/testing.js';
import {
  deriveRejectedForEachDeclarations,
  isRejectedForEachCollection,
} from '../src/execution/coordinator/coordinator-rejected-loop-proof.js';

type V2 = Extract<PersistedWorkflowCheckpoint, { schemaVersion: 2 }>;
type Plan = ParsedTransitionPlan & { checkpoint: V2 };
const version = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const nodeRunId = '00000000-0000-4000-8000-000000000003';
const key = encodeWorkflowInvocationKeyV2({
  workflowVersionId: version,
  nodeId: 'loop',
});
const executable = {
  schemaVersion: 2,
  graph: {
    nodes: [
      {
        id: 'loop',
        definition: { key: 'core.foreach', version: 1 },
        structured: {
          kind: 'for_each',
          maxIterations: 3,
          maxConcurrency: 1,
          body: { nodes: [] },
        },
      },
    ],
  },
};
function fixture(): {
  executableJson: unknown;
  currentCheckpoint: V2;
  plan: Plan;
  persistedFacts: CoordinatorEventRow[];
} {
  const control = {
    invocationKey: key,
    nodeId: 'loop',
    status: 'running' as const,
    attemptNumber: 1,
    branchPath: [],
    iterationPath: [],
  };
  const currentCheckpoint: V2 = {
    schemaVersion: 2,
    engineVersion: 'engine-v1',
    workflowVersionId: version,
    revision: 2,
    runStatus: 'running',
    nextEventSequence: 5,
    readySet: [],
    admittedInvocationKeys: [key],
    invocations: [control],
    joins: [],
    loops: [],
    remainingIterationBudget: 10,
    initialIterationBudget: 10,
    branchSelections: [],
    cancelRequested: false,
    deadlineExpired: false,
  };
  const plan: Plan = {
    expectedRevision: 2,
    expectedNextEventSequence: 5,
    consumedThroughEventSequence: 5,
    checkpoint: {
      ...currentCheckpoint,
      revision: 3,
      runStatus: 'failed',
      nextEventSequence: 8,
      invocations: [{ ...control, status: 'failed' }],
    },
    events: [
      {
        schemaVersion: 1,
        sequence: 6,
        name: 'node.failed',
        occurredAt: '2026-10-02T00:00:00.000Z',
        invocationKey: key,
        nodeId: 'loop',
        attemptNumber: 1,
        reasonCode: 'loop_limit_exceeded',
      },
      {
        schemaVersion: 1,
        sequence: 7,
        name: 'run.failed',
        occurredAt: '2026-10-02T00:00:00.000Z',
      },
    ],
    attempts: [],
    nodeRunAdmissions: [],
  };
  const stored = {
    schemaVersion: 1,
    kind: 'inline',
    value: { items: ['a', 'b', 'c', 'd'], iterationCount: 4 },
  };
  const fact: CoordinatorEventRow = {
    sequence: 5,
    type: 'node.succeeded',
    payload: {
      schemaVersion: 1,
      attemptId,
      nodeRunId,
      invocationKey: key,
      nodeId: 'loop',
      attemptNumber: 1,
    },
    created_at: new Date('2026-10-02T00:00:00.000Z'),
    attempt_id: attemptId,
    attempt_number: 1,
    attempt_status: 'succeeded',
    attempt_output_ref: stored,
    node_output_ref: stored,
    executor_failure_kind: null,
    invocation_key: key,
    node_run_id: nodeRunId,
    node_id: 'loop',
    current_attempt_id: attemptId,
    node_status: 'succeeded',
    resume_at: null,
    retry_due_at: null,
    retry_decision: null,
    wait_kind: null,
  };
  return {
    executableJson: executable,
    currentCheckpoint,
    plan,
    persistedFacts: [fact],
  };
}
function output(input: ReturnType<typeof fixture>, value: unknown) {
  const stored = { schemaVersion: 1, kind: 'inline', value };
  input.persistedFacts = input.persistedFacts.map((fact) => ({
    ...fact,
    attempt_output_ref: stored,
    node_output_ref: stored,
  }));
}
it('derives a max-bound rejection from actual owned success output, not plan claims', () => {
  expect(deriveRejectedForEachDeclarations(fixture())).toEqual(
    new Map([[key, { attemptId, nodeId: 'loop', attemptNumber: 1 }]]),
  );
});
it('derives a budget-only rejection with no other new loop declaration', () => {
  const input = fixture();
  input.currentCheckpoint = {
    ...input.currentCheckpoint,
    remainingIterationBudget: 1,
  };
  input.plan = {
    ...input.plan,
    checkpoint: { ...input.plan.checkpoint, remainingIterationBudget: 1 },
  };
  output(input, { items: [1, 2], iterationCount: 2 });
  expect(deriveRejectedForEachDeclarations(input).size).toBe(1);
});
it('returns an empty map for ordinary noncandidate plans without inspecting executable metadata', () => {
  const input = fixture();
  input.plan = { ...input.plan, events: [] };
  input.executableJson = null;
  expect(deriveRejectedForEachDeclarations(input).size).toBe(0);
});
it.each([
  'inrange',
  'empty',
  'count-mismatch',
  'extra-output',
  'artifact',
  'missing-fact',
  'duplicate-fact',
  'attempt',
  'node',
  'current-attempt',
  'physical-failed',
  'output-mismatch',
  'payload-node',
  'payload-attempt',
  'event-node',
  'event-attempt',
  'event-name',
  'missing-run-failure',
  'admission',
  'attempt-admission',
  'retained-output',
  'scope',
  'ordinary-definition',
  'unknown-version',
  'malformed-bounds',
  'version',
  'cancel',
  'ambiguous-budget',
  'existing-control-ledger',
  'new-control-ledger',
] as const)('rejects forged or insufficient %s proof', (kind) => {
  const input = fixture();
  const first = input.persistedFacts[0];
  if (first === undefined) throw new Error('Owned success fact missing');
  switch (kind) {
    case 'inrange':
      output(input, { items: [1], iterationCount: 1 });
      break;
    case 'empty':
      output(input, { items: [], iterationCount: 0 });
      break;
    case 'count-mismatch':
      output(input, { items: [1, 2, 3, 4], iterationCount: 3 });
      break;
    case 'extra-output':
      output(input, { items: [1, 2, 3, 4], iterationCount: 4, extra: true });
      break;
    case 'artifact':
      input.persistedFacts = [
        {
          ...first,
          attempt_output_ref: {
            schemaVersion: 1,
            kind: 'artifact',
            artifactId: attemptId,
          },
          node_output_ref: {
            schemaVersion: 1,
            kind: 'artifact',
            artifactId: attemptId,
          },
        },
      ];
      break;
    case 'missing-fact':
      input.persistedFacts = [];
      break;
    case 'duplicate-fact':
      input.persistedFacts = [first, first];
      break;
    case 'attempt':
      input.persistedFacts = [{ ...first, attempt_number: 2 }];
      break;
    case 'node':
      input.persistedFacts = [{ ...first, node_id: 'ordinary' }];
      break;
    case 'current-attempt':
      input.persistedFacts = [{ ...first, current_attempt_id: nodeRunId }];
      break;
    case 'physical-failed':
      input.persistedFacts = [{ ...first, node_status: 'failed' }];
      break;
    case 'output-mismatch':
      input.persistedFacts = [{ ...first, node_output_ref: null }];
      break;
    case 'payload-node':
      input.persistedFacts = [
        {
          ...first,
          payload: {
            schemaVersion: 1,
            attemptId,
            nodeRunId,
            invocationKey: key,
            nodeId: 'forged',
            attemptNumber: 1,
          },
        },
      ];
      break;
    case 'payload-attempt':
      input.persistedFacts = [
        {
          ...first,
          payload: {
            schemaVersion: 1,
            attemptId,
            nodeRunId,
            invocationKey: key,
            nodeId: 'loop',
            attemptNumber: 2,
          },
        },
      ];
      break;
    case 'event-node':
      input.plan = {
        ...input.plan,
        events: input.plan.events.map((event) =>
          event.name === 'node.failed'
            ? { ...event, nodeId: 'ordinary' }
            : event,
        ),
      };
      break;
    case 'event-attempt':
      input.plan = {
        ...input.plan,
        events: input.plan.events.map((event) =>
          event.name === 'node.failed' ? { ...event, attemptNumber: 2 } : event,
        ),
      };
      break;
    case 'event-name':
      input.plan = {
        ...input.plan,
        events: input.plan.events.map((event) => ({
          ...event,
          name: 'node.succeeded',
        })),
      };
      break;
    case 'missing-run-failure':
      input.plan = {
        ...input.plan,
        events: input.plan.events.filter(
          (event) => event.name !== 'run.failed',
        ),
      };
      break;
    case 'admission':
      input.plan = {
        ...input.plan,
        nodeRunAdmissions: [
          { invocationKey: 'body', nodeId: 'body', sideEffectClass: 'safe' },
        ],
      };
      break;
    case 'attempt-admission':
      input.plan = {
        ...input.plan,
        attempts: [
          {
            invocationKey: 'body',
            nodeId: 'body',
            sideEffectClass: 'safe',
            attemptNumber: 1,
            admissionKind: 'execute',
          },
        ],
      };
      break;
    case 'retained-output':
      input.plan = {
        ...input.plan,
        checkpoint: {
          ...input.plan.checkpoint,
          invocations: input.plan.checkpoint.invocations.map((node) => ({
            ...node,
            output: { kind: 'inline', attemptId },
          })),
        },
      };
      break;
    case 'scope':
      input.plan = {
        ...input.plan,
        checkpoint: {
          ...input.plan.checkpoint,
          invocations: input.plan.checkpoint.invocations.map((node) => ({
            ...node,
            iterationPath: [{ loopNodeId: 'forged', ordinal: 0 }],
          })),
        },
      };
      break;
    case 'ordinary-definition':
      input.executableJson = {
        schemaVersion: 2,
        graph: {
          nodes: [{ id: 'loop', definition: { key: 'core.set', version: 1 } }],
        },
      };
      break;
    case 'unknown-version':
      input.executableJson = {
        schemaVersion: 2,
        graph: {
          nodes: [
            {
              ...executable.graph.nodes[0],
              definition: { key: 'core.foreach', version: 2 },
            },
          ],
        },
      };
      break;
    case 'malformed-bounds':
      input.executableJson = {};
      break;
    case 'version':
      input.plan = {
        ...input.plan,
        checkpoint: { ...input.plan.checkpoint, workflowVersionId: attemptId },
      };
      break;
    case 'cancel':
      input.currentCheckpoint = {
        ...input.currentCheckpoint,
        cancelRequested: true,
      };
      break;
    case 'existing-control-ledger':
    case 'new-control-ledger':
    case 'ambiguous-budget': {
      input.currentCheckpoint = {
        ...input.currentCheckpoint,
        remainingIterationBudget: 1,
      };
      output(input, { items: [1, 2], iterationCount: 2 });
      input.plan = {
        ...input.plan,
        checkpoint: {
          ...input.plan.checkpoint,
          remainingIterationBudget: 1,
          loops: [
            {
              controlInvocationKey: kind === 'ambiguous-budget' ? 'other' : key,
              loopId: 'other',
              branchPath: [],
              iterationPath: [],
              bodyRootNodeIds: ['body'],
              bodySinkNodeId: 'body',
              collection: { kind: 'inline', attemptId },
              collectionChecksum: 'a',
              collectionSize: 0,
              maxConcurrency: 1,
              maxIterations: 3,
              nextOrdinal: 0,
              activeOrdinals: [],
              terminalOrdinals: [],
            },
          ],
        },
      };
      if (kind === 'existing-control-ledger')
        input.currentCheckpoint = {
          ...input.currentCheckpoint,
          loops: input.plan.checkpoint.loops,
        };
      break;
    }
  }
  expect(() => deriveRejectedForEachDeclarations(input)).toThrow(
    CoordinatorPlanInvalidError,
  );
});
it('retained predicate rejects inrange, empty, malformed, or wrong ancestor scope', () => {
  const bounds = workflowForEachBoundsV2(executable);
  const base = {
    nodeId: 'loop',
    iterationPath: [],
    bounds,
    remainingIterationBudget: 10,
  };
  expect(
    isRejectedForEachCollection({
      ...base,
      value: { items: [1, 2, 3, 4], iterationCount: 4 },
    }),
  ).toBe(true);
  for (const value of [
    null,
    { items: [], iterationCount: 0 },
    { items: [1], iterationCount: 1 },
    { items: [1, 2, 3, 4], iterationCount: 5 },
  ])
    expect(isRejectedForEachCollection({ ...base, value })).toBe(false);
  expect(
    isRejectedForEachCollection({
      ...base,
      iterationPath: [{ loopNodeId: 'forged', ordinal: 0 }],
      value: { items: [1, 2, 3, 4], iterationCount: 4 },
    }),
  ).toBe(false);
});
