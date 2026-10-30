import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { invocationKey } from '../../../src/index.js';
import {
  advanceWorkflow,
  decideRetry,
  type WorkflowObservation,
} from '../../support/engine.js';
import {
  FOUR_NODE_IDS,
  SIX_NODE_IDS,
  FOUR_NODE_EDGES,
  MODEL_SEED,
  modelRuns,
  graphForMask,
  freshCheckpoint,
  verifySuccessfulRun,
} from '../../support/transition/model.js';

describe('bounded workflow state-machine model', () => {
  it('exhaustively preserves deterministic and monotonic transition invariants for every four-node DAG', () => {
    for (let mask = 0; mask < 1 << FOUR_NODE_EDGES.length; mask += 1) {
      const schedulerState = graphForMask(mask);
      verifySuccessfulRun(schedulerState, FOUR_NODE_IDS.length);
    }
  });
  it('uses a seeded shrinkable budget for larger legal DAGs and terminal replay', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fff }), (mask) => {
        const schedulerState = graphForMask(mask, SIX_NODE_IDS);
        const terminal = verifySuccessfulRun(
          schedulerState,
          SIX_NODE_IDS.length,
        );
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
});
