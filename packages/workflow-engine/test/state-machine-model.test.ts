import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  createCheckpoint,
  createCheckpointV2,
  invocationKey,
  type WorkflowCheckpoint,
} from '../src/index.js';
import {
  advanceWorkflow,
  configuredParallelOutputPorts,
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
const MODEL_RUN_MULTIPLIER =
  process.env.WORKFLOW_MODEL_RUN_MULTIPLIER === '4' ? 4 : 1;
const modelRuns = (base: number): number => base * MODEL_RUN_MULTIPLIER;
const WORKFLOW_VERSION_ID = '00000000-0000-4000-8000-000000000001';
const COLLECTION_ATTEMPT_ID = '00000000-0000-4000-8000-000000000101';

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

function startStructuredLoop(input: {
  readonly bodyNodeCount: number;
  readonly collectionSize: number;
  readonly maxConcurrency: number;
  readonly reserveBudget: number;
}) {
  const schedulerState = structuredGraph(input.bodyNodeCount);
  const initialIterationBudget = input.collectionSize + input.reserveBudget;
  const started = advanceWorkflow({
    checkpoint: createCheckpointV2({
      engineVersion: 'engine-v2',
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

function expectLoopBudgetConserved(
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
  expect(accountedOrdinals).toHaveLength(loop.nextOrdinal);
  expect(loop.nextOrdinal).toBeLessThanOrEqual(collectionSize);
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
  it('fails closed for malformed or unsupported generated Parallel projections', () => {
    expect(
      configuredParallelOutputPorts({
        definition: { key: 'core.parallel', version: 4 },
        config: { branches: [{ id: 'branch-01' }, { id: 'branch-02' }] },
      }),
    ).toBeUndefined();
    expect(
      configuredParallelOutputPorts({
        definition: { key: 'core.parallel', version: 3 },
        config: { branches: 'branch-01' },
      }),
    ).toBeUndefined();
    expect(
      configuredParallelOutputPorts({
        definition: { key: 'core.parallel', version: 3 },
        config: { branches: [null, { id: 'branch-02' }] },
      }),
    ).toBeUndefined();
  });

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
      { seed: MODEL_SEED, numRuns: modelRuns(512) },
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
      { seed: MODEL_SEED + 1, numRuns: modelRuns(256) },
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
      { seed: MODEL_SEED + 2, numRuns: modelRuns(256) },
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
      { seed: MODEL_SEED + 3, numRuns: modelRuns(512) },
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
      { seed: MODEL_SEED + 4, numRuns: modelRuns(512) },
    );
  });

  it('conserves loop budgets through generated structured execution sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 0, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        (
          collectionSize,
          bodyNodeCount,
          reserveBudget,
          concurrencyCandidate,
        ) => {
          const maxConcurrency = Math.min(
            Math.max(1, collectionSize),
            concurrencyCandidate,
          );
          const { declared, initialIterationBudget, schedulerState } =
            startStructuredLoop({
              bodyNodeCount,
              collectionSize,
              maxConcurrency,
              reserveBudget,
            });
          let checkpoint = declared.checkpoint;
          expectLoopBudgetConserved(
            checkpoint,
            initialIterationBudget,
            collectionSize,
          );

          for (
            let turn = 0;
            turn < collectionSize * (bodyNodeCount + 1) + 1;
            turn += 1
          ) {
            if (checkpoint.runStatus === 'succeeded') break;
            const running = checkpoint.invocations.filter(
              ({ iterationPath, status }) =>
                iterationPath !== undefined && status === 'running',
            );
            if (running.length === 0)
              throw new Error('structured sequence made no progress');
            const sinkNodeId = `body-${String(bodyNodeCount - 1)}`;
            const loop = checkpoint.loops[0];
            if (loop === undefined)
              throw new Error('structured loop state is missing');
            const observations: WorkflowObservation[] = running.map(
              (invocation) =>
                invocation.nodeId === sinkNodeId
                  ? {
                      kind: 'loop_iteration_completed',
                      loopId: 'loop',
                      controlInvocationKey: loop.controlInvocationKey,
                      invocationKey: invocation.invocationKey,
                      ordinal: invocation.iterationPath?.at(-1)?.ordinal ?? -1,
                      status: 'succeeded',
                    }
                  : {
                      kind: 'outcome',
                      invocationKey: invocation.invocationKey,
                      status: 'succeeded',
                    },
            );
            checkpoint = advanceWorkflow({
              checkpoint,
              schedulerState,
              occurredAt: '2026-08-20T10:02:00.000Z',
              maximumAdmissions: 16,
              observations,
            }).checkpoint;
            expectLoopBudgetConserved(
              checkpoint,
              initialIterationBudget,
              collectionSize,
            );
          }

          expect(checkpoint.runStatus).toBe('succeeded');
          expect(checkpoint.loops[0]?.terminalOrdinals).toEqual(
            Array.from({ length: collectionSize }, (_, ordinal) => ordinal),
          );
        },
      ),
      { seed: MODEL_SEED + 5, numRuns: modelRuns(256) },
    );
  });

  it('never resumes generated structured retries after cancellation', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        (collectionSize, concurrencyCandidate) => {
          const { declared, schedulerState } = startStructuredLoop({
            bodyNodeCount: 1,
            collectionSize,
            maxConcurrency: Math.min(collectionSize, concurrencyCandidate),
            reserveBudget: 0,
          });
          const retrying = declared.checkpoint.invocations.find(
            ({ iterationPath, status }) =>
              iterationPath !== undefined && status === 'running',
          );
          if (retrying === undefined)
            throw new Error('structured iteration was not admitted');
          const waiting = advanceWorkflow({
            checkpoint: declared.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:02:00.000Z',
            maximumAdmissions: 16,
            observations: [
              {
                kind: 'wait',
                invocationKey: retrying.invocationKey,
                resumeAt: '2026-08-20T10:03:00.000Z',
                waitKind: 'retry_backoff',
              },
            ],
          });
          const canceled = advanceWorkflow({
            checkpoint: waiting.checkpoint,
            schedulerState,
            occurredAt: '2026-08-20T10:02:30.000Z',
            maximumAdmissions: 16,
            observations: [{ kind: 'cancel_requested' }],
            dueResumptions: [
              {
                invocationKey: retrying.invocationKey,
                occurredAt: '2026-08-20T10:03:00.000Z',
              },
            ],
          });
          expect(canceled.checkpoint.runStatus).toBe('canceled');
          expect(canceled.checkpoint.cancelRequested).toBe(true);
          expect(canceled.attempts).toEqual([]);
          expect(
            canceled.checkpoint.invocations.find(
              ({ invocationKey: key }) => key === retrying.invocationKey,
            )?.status,
          ).toBe('canceled');
        },
      ),
      { seed: MODEL_SEED + 6, numRuns: modelRuns(256) },
    );
  });
});
