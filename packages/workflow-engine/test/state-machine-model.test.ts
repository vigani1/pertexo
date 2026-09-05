import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  createCheckpoint,
  invocationKey,
  type WorkflowCheckpoint,
} from '../src/index.js';
import {
  advanceWorkflow,
  decideRetry,
  type SchedulerGraph,
  type WorkflowObservation,
} from '../src/testing.js';

const FOUR_NODE_IDS = ['a', 'b', 'c', 'd'] as const;
const SIX_NODE_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const;
const FOUR_NODE_EDGES = FOUR_NODE_IDS.flatMap((source, sourceIndex) =>
  FOUR_NODE_IDS.slice(sourceIndex + 1).map((target) => ({ source, target })),
);
const MODEL_SEED = 0x50_45_52_54;

function graphForMask(
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

function freshCheckpoint(): WorkflowCheckpoint {
  return createCheckpoint({
    engineVersion: 'engine-v1',
    workflowVersionId: '00000000-0000-4000-8000-000000000001',
    iterationBudget: 64,
  });
}

function successfulRun(
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

describe('bounded workflow state-machine model', () => {
  it('exhaustively preserves deterministic and monotonic transition invariants for every four-node DAG', () => {
    for (let mask = 0; mask < 1 << FOUR_NODE_EDGES.length; mask += 1) {
      const schedulerState = graphForMask(mask);
      successfulRun(schedulerState, FOUR_NODE_IDS.length);
    }
  });

  it('uses a seeded shrinkable budget for larger legal DAGs and terminal replay', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fff }), (mask) => {
        const schedulerState = graphForMask(mask, SIX_NODE_IDS);
        const terminal = successfulRun(schedulerState, SIX_NODE_IDS.length);
        const replay = advanceWorkflow({
          checkpoint: terminal,
          schedulerState,
          occurredAt: '2026-08-20T10:01:00.000Z',
          maximumAdmissions: SIX_NODE_IDS.length,
          observations: [],
        });
        expect(replay.events).toEqual([]);
        expect(replay.attempts).toEqual([]);
        expect(replay.checkpoint.runStatus).toBe(terminal.runStatus);
        expect(replay.checkpoint.invocations).toEqual(terminal.invocations);
        expect(replay.checkpoint.revision).toBe(terminal.revision + 1);
      }),
      { seed: MODEL_SEED, numRuns: 512 },
    );
  });

  it('rejects shrinkable duplicate and unknown outcome sequences', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fff }), (mask) => {
        const schedulerState = graphForMask(mask, SIX_NODE_IDS);
        const started = advanceWorkflow({
          checkpoint: freshCheckpoint(),
          schedulerState,
          occurredAt: '2026-08-20T10:00:00.000Z',
          maximumAdmissions: SIX_NODE_IDS.length,
          observations: [],
        });
        const key = started.attempts[0]?.invocationKey;
        if (key === undefined) throw new Error('DAG did not admit a root');
        const duplicate = {
          kind: 'outcome' as const,
          invocationKey: key,
          status: 'succeeded' as const,
        };
        const once = advanceWorkflow({
          checkpoint: started.checkpoint,
          schedulerState,
          occurredAt: '2026-08-20T10:01:00.000Z',
          maximumAdmissions: SIX_NODE_IDS.length,
          observations: [duplicate],
        });
        const replayed = advanceWorkflow({
          checkpoint: started.checkpoint,
          schedulerState,
          occurredAt: '2026-08-20T10:01:00.000Z',
          maximumAdmissions: SIX_NODE_IDS.length,
          observations: [duplicate, duplicate],
        });
        expect(replayed).toEqual(once);
        expect(() =>
          advanceWorkflow({
            checkpoint: started.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:01:00.000Z',
            maximumAdmissions: SIX_NODE_IDS.length,
            observations: [
              {
                kind: 'outcome',
                invocationKey: 'unknown-invocation',
                status: 'succeeded',
              },
            ],
          }),
        ).toThrow();
      }),
      { seed: MODEL_SEED + 1, numRuns: 256 },
    );
  });

  it('never resurrects shrinkable canceled runs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fff }),
        fc.integer({ min: 1, max: SIX_NODE_IDS.length }),
        (mask, admissionLimit) => {
          const schedulerState = graphForMask(mask, SIX_NODE_IDS);
          const started = advanceWorkflow({
            checkpoint: freshCheckpoint(),
            schedulerState,
            occurredAt: '2026-08-20T10:00:00.000Z',
            maximumAdmissions: admissionLimit,
            observations: [],
          });
          const cancellationRequested = advanceWorkflow({
            checkpoint: started.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:01:00.000Z',
            maximumAdmissions: SIX_NODE_IDS.length,
            observations: [{ kind: 'cancel_requested' }],
          });
          expect(cancellationRequested.attempts).toEqual([]);
          const cancellations: WorkflowObservation[] =
            cancellationRequested.checkpoint.invocations
              .filter(({ status }) => status === 'running')
              .map(({ invocationKey: key }) => ({
                kind: 'outcome',
                invocationKey: key,
                status: 'canceled',
              }));
          const canceled = advanceWorkflow({
            checkpoint: cancellationRequested.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:01:30.000Z',
            maximumAdmissions: SIX_NODE_IDS.length,
            observations: cancellations,
          });
          expect(canceled.checkpoint.runStatus).toBe('canceled');
          expect(canceled.attempts).toEqual([]);
          const replay = advanceWorkflow({
            checkpoint: canceled.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:02:00.000Z',
            maximumAdmissions: SIX_NODE_IDS.length,
            observations: [],
          });
          expect(replay.checkpoint.runStatus).toBe('canceled');
          expect(replay.checkpoint.invocations).toEqual(
            canceled.checkpoint.invocations,
          );
          expect(replay.attempts).toEqual([]);
        },
      ),
      { seed: MODEL_SEED + 2, numRuns: 256 },
    );
  });

  it('keeps generated branch and loop scopes deterministic and distinct', () => {
    const pathSegment = fc.stringMatching(/^[a-z]{1,8}$/u);
    const branchPath = fc.array(pathSegment, { maxLength: 4 });
    const iterationPath = fc.array(
      fc.record({
        loopNodeId: pathSegment,
        ordinal: fc.integer({ min: 0, max: 999 }),
      }),
      { maxLength: 4 },
    );
    fc.assert(
      fc.property(
        branchPath,
        iterationPath,
        branchPath,
        iterationPath,
        (leftBranches, leftIterations, rightBranches, rightIterations) => {
          const base = {
            workflowVersionId: '00000000-0000-4000-8000-000000000001',
            nodeId: 'node',
          };
          const left = invocationKey({
            ...base,
            branchPath: leftBranches,
            iterationPath: leftIterations,
          });
          expect(
            invocationKey({
              ...base,
              branchPath: leftBranches,
              iterationPath: leftIterations,
            }),
          ).toBe(left);
          const right = invocationKey({
            ...base,
            branchPath: rightBranches,
            iterationPath: rightIterations,
          });
          if (
            JSON.stringify([leftBranches, leftIterations]) !==
            JSON.stringify([rightBranches, rightIterations])
          )
            expect(right).not.toBe(left);
        },
      ),
      { seed: MODEL_SEED + 3, numRuns: 512 },
    );
  });

  it('keeps generated retry plans deterministic, bounded, and monotonic', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 10_000 }),
        (currentAttemptNumber, maximumAttempts, maximumDelayMs) => {
          const input = {
            sideEffectClass: 'safe' as const,
            currentAttemptNumber,
            policy: {
              maximumAttempts,
              baseDelayMs: 1,
              maximumDelayMs,
              retryableErrorCodes: ['network'],
            },
            observation: {
              kind: 'definite_failure' as const,
              errorCode: 'network',
            },
          };
          const decision = decideRetry(input);
          expect(decideRetry(input)).toEqual(decision);
          if (currentAttemptNumber >= maximumAttempts)
            expect(decision.kind).toBe('failed');
          else {
            expect(decision).toMatchObject({
              kind: 'retry',
              attemptNumber: currentAttemptNumber + 1,
            });
            if (decision.kind === 'retry')
              expect(decision.delayMs).toBeLessThanOrEqual(maximumDelayMs);
          }
        },
      ),
      { seed: MODEL_SEED + 4, numRuns: 512 },
    );
  });
});
