import { expect } from 'vitest';

import {
  createCheckpoint,
  type WorkflowCheckpoint,
} from '../../../src/index.js';
import {
  advanceWorkflow,
  type SchedulerGraph,
  type WorkflowObservation,
} from '../engine.js';
export const FOUR_NODE_IDS = ['a', 'b', 'c', 'd'] as const;
export const SIX_NODE_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
export const FOUR_NODE_EDGES = FOUR_NODE_IDS.flatMap((source, sourceIndex) =>
  FOUR_NODE_IDS.slice(sourceIndex + 1).map((target) => ({ source, target })),
);
export const MODEL_SEED = 0x50_45_52_54;
const MODEL_RUN_MULTIPLIER =
  process.env.WORKFLOW_MODEL_RUN_MULTIPLIER === '4' ? 4 : 1;
export const modelRuns = (base: number): number => base * MODEL_RUN_MULTIPLIER;
const WORKFLOW_VERSION_ID = '00000000-0000-4000-8000-000000000001';
const COLLECTION_ATTEMPT_ID = '00000000-0000-4000-8000-000000000101';
export function graphForMask(
  mask: number,
  nodeIds: readonly string[] = FOUR_NODE_IDS,
): SchedulerGraph {
  const possibleEdges = nodeIds.flatMap((source, sourceIndex) =>
    nodeIds.slice(sourceIndex + 1).map((target) => ({ source, target })),
  );
  return {
    deriveReadiness: true,
    nodes: nodeIds.map((id) => ({ id, sideEffectClass: 'safe' })),
    edges: possibleEdges.flatMap(({ source, target }, index) =>
      (mask & (1 << index)) === 0
        ? []
        : [
            {
              source: { nodeId: source, port: 'output' },
              target: { nodeId: target, port: 'input' },
            },
          ],
    ),
    structuredBodies: [],
  };
}
export function freshCheckpoint(): WorkflowCheckpoint {
  return createCheckpoint({
    workflowVersionId: WORKFLOW_VERSION_ID,
    iterationBudget: 64,
  });
}
function structuredGraph(bodyNodeCount: number): SchedulerGraph {
  const bodyNodeIds = Array.from(
    { length: bodyNodeCount },
    (_, index) => `body-${String(index)}`,
  );
  return {
    deriveReadiness: true,
    nodes: [{ id: 'loop', sideEffectClass: 'safe' }],
    edges: [],
    structuredBodies: [
      {
        loopNodeId: 'loop',
        nodes: bodyNodeIds.map((id) => ({ id, sideEffectClass: 'safe' })),
        edges: bodyNodeIds.slice(1).map((target, index) => ({
          source: { nodeId: bodyNodeIds[index] ?? '', port: 'output' },
          target: { nodeId: target, port: 'input' },
        })),
      },
    ],
  };
}
export function startStructuredLoop(input: {
  readonly bodyNodeCount: number;
  readonly collectionSize: number;
  readonly maxConcurrency: number;
  readonly reserveBudget: number;
}) {
  const schedulerState = structuredGraph(input.bodyNodeCount);
  const initialIterationBudget = input.collectionSize + input.reserveBudget;
  const started = advanceWorkflow({
    checkpoint: createCheckpoint({
      workflowVersionId: WORKFLOW_VERSION_ID,
      iterationBudget: initialIterationBudget,
    }),
    schedulerState,
    occurredAt: '2026-08-20T10:00:00.000Z',
    maximumAdmissions: 16,
    observations: [],
  });
  const control = started.attempts[0];
  if (control === undefined)
    throw new Error('For Each control was not admitted');
  const declared = advanceWorkflow({
    checkpoint: started.checkpoint,
    schedulerState,
    occurredAt: '2026-08-20T10:01:00.000Z',
    maximumAdmissions: 16,
    observations: [
      {
        kind: 'loop_started',
        loopId: 'loop',
        controlInvocationKey: control.invocationKey,
        branchPath: [],
        iterationPath: [],
        bodyRootNodeIds: ['body-0'],
        bodySinkNodeId: `body-${String(input.bodyNodeCount - 1)}`,
        collection: { kind: 'inline', attemptId: COLLECTION_ATTEMPT_ID },
        collectionChecksum: `collection-${String(input.collectionSize)}`,
        collectionSize: input.collectionSize,
        maxIterations: Math.max(1, input.collectionSize),
        maxConcurrency: input.maxConcurrency,
      },
    ],
  });
  return { declared, initialIterationBudget, schedulerState };
}
export function expectLoopBudgetConserved(
  checkpoint: WorkflowCheckpoint,
  initialIterationBudget: number,
  collectionSize: number,
): void {
  expect(initialIterationBudget - checkpoint.remainingIterationBudget).toBe(
    collectionSize,
  );
  const loop = checkpoint.loops[0];
  if (loop === undefined) throw new Error('structured loop state is missing');
  const accountedOrdinals = [...loop.activeOrdinals, ...loop.terminalOrdinals];
  expect(new Set(accountedOrdinals).size).toBe(accountedOrdinals.length);
  expect(accountedOrdinals.length + loop.completedPrefix).toBe(
    loop.nextOrdinal,
  );
  expect(loop.nextOrdinal).toBeLessThanOrEqual(collectionSize);
}
export function verifySuccessfulRun(
  schedulerState: SchedulerGraph,
  nodeCount: number,
): WorkflowCheckpoint {
  let checkpoint = freshCheckpoint();
  const admitted = new Set<string>();
  let previousSequence = checkpoint.nextEventSequence;
  for (let turn = 0; turn <= nodeCount; turn += 1) {
    const observations: WorkflowObservation[] = checkpoint.invocations
      .filter(({ status }) => status === 'running')
      .map(({ invocationKey: key }) => ({
        kind: 'outcome',
        invocationKey: key,
        status: 'succeeded',
      }));
    const input = {
      checkpoint,
      schedulerState,
      observations,
      occurredAt: '2026-08-20T10:00:00.000Z',
      maximumAdmissions: nodeCount,
    } as const;
    const first = advanceWorkflow(input);
    expect(advanceWorkflow(input)).toEqual(first);
    expect(first.events.map(({ sequence }) => sequence)).toEqual(
      Array.from(
        { length: first.events.length },
        (_, index) => previousSequence + index,
      ),
    );
    previousSequence += first.events.length;
    for (const attempt of first.attempts) {
      expect(admitted.has(attempt.invocationKey)).toBe(false);
      admitted.add(attempt.invocationKey);
    }
    checkpoint = first.checkpoint;
    if (checkpoint.runStatus === 'succeeded') break;
  }
  expect(checkpoint.runStatus).toBe('succeeded');
  expect(admitted.size).toBe(nodeCount);
  expect(
    checkpoint.invocations.every(({ status }) => status === 'succeeded'),
  ).toBe(true);
  return checkpoint;
}
