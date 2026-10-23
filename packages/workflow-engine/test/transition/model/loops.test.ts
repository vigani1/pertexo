import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  advanceWorkflow,
  type WorkflowObservation,
} from '../../support/engine.js';
import {
  MODEL_SEED,
  modelRuns,
  startStructuredLoop,
  expectLoopBudgetConserved,
} from '../../support/transition/model.js';

describe('bounded workflow state-machine model', () => {
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
          expect(checkpoint.loops[0]).toMatchObject({
            completedPrefix: collectionSize,
            terminalOrdinals: [],
          });
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
          expect(canceled.checkpoint.cancelRequested).toBe(true);
          expect(canceled.attempts).toEqual([]);
          expect(
            [
              ...canceled.checkpoint.invocations,
              ...(canceled.prunedInvocations ?? []),
            ].find(({ invocationKey: key }) => key === retrying.invocationKey)
              ?.status,
          ).toBe('canceled');
          const runningBody = canceled.checkpoint.invocations.filter(
            ({ iterationPath, status }) =>
              iterationPath !== undefined && status === 'running',
          );
          expect(canceled.checkpoint.runStatus).toBe(
            runningBody.length === 0 ? 'canceled' : 'running',
          );
          for (const invocation of runningBody)
            expect(
              canceled.checkpoint.loops.some(({ activeOrdinals, loopId }) => {
                const scope = invocation.iterationPath?.find(
                  ({ loopNodeId }) => loopNodeId === loopId,
                );
                return (
                  scope !== undefined && activeOrdinals.includes(scope.ordinal)
                );
              }),
            ).toBe(true);
        },
      ),
      { seed: MODEL_SEED + 6, numRuns: modelRuns(256) },
    );
  });
});
