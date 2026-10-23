import { describe, expect, it } from 'vitest';

import {
  advanceWorkflow,
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
  type WorkflowCheckpoint,
} from '../../../../src/index.js';
import { nodeCatalog } from '../../../support/executable-workflow.js';
import {
  rootParallelWithDescendantLoop,
  createDriver,
} from '../../../support/scheduling/nested-parallel.js';

describe('nested Parallel admission through the public engine', () => {
  it('enforces a limit of one independently in both loop iterations', async () => {
    const driver = await createDriver(1);
    const branches = await driver.complete('parallel', {
      branchIds: ['branch-01', 'branch-02'],
    });
    expect(
      branches.attempts.map(({ nodeId, iterationPath }) => [
        nodeId,
        iterationPath?.at(-1)?.ordinal,
      ]),
    ).toEqual([
      ['left', 0],
      ['left', 1],
    ]);
    expect((await driver.advance()).attempts).toEqual([]);
    const next = await driver.complete('left', {}, 0);
    expect(
      next.attempts.map(({ nodeId, iterationPath }) => [
        nodeId,
        iterationPath?.at(-1)?.ordinal,
      ]),
    ).toEqual([['right', 0]]);
    expect((await driver.advance()).attempts).toEqual([]);
  });
  it.each([
    { branchCount: 3, maxConcurrency: 1 },
    { branchCount: 3, maxConcurrency: 2 },
    { branchCount: 3, maxConcurrency: 3 },
  ])(
    'enforces configured limit $maxConcurrency independently for every loop iteration',
    async ({ branchCount, maxConcurrency }) => {
      const driver = await createDriver(maxConcurrency, branchCount);
      const branches = await driver.complete('parallel', {
        branchIds: Array.from(
          { length: branchCount },
          (_, index) => `branch-${String(index + 1).padStart(2, '0')}`,
        ),
      });
      expect(branches.attempts).toHaveLength(maxConcurrency * 2);
      for (const ordinal of [0, 1]) {
        const admitted = branches.attempts.filter(
          ({ iterationPath }) => iterationPath?.at(-1)?.ordinal === ordinal,
        );
        expect(admitted).toHaveLength(maxConcurrency);
        expect(new Set(admitted.map(({ nodeId }) => nodeId)).size).toBe(
          maxConcurrency,
        );
      }
    },
  );
  it.each([1, 2] as const)(
    'keeps a root Parallel cap global across descendant loop iterations ($maxConcurrency)',
    async (maxConcurrency) => {
      const graph = rootParallelWithDescendantLoop(maxConcurrency);
      const executable = buildWorkflowExecutable({
        graph,
        catalog: composeExecutableCatalog(
          nodeCatalog({
            forEach: true,
            parallel: true,
            merge: true,
          }),
        ),
      });
      const base = {
        runId: `root-parallel-${String(maxConcurrency)}`,
        executable,
        workflowVersionId: '00000000-0000-4000-8000-000000000102',
        occurredAt: '2026-08-24T00:00:00.000Z',
        maximumAdmissions: 16,
        signal: new AbortController().signal,
      } as const;
      let checkpoint: WorkflowCheckpoint = createCheckpoint({
        workflowVersionId: base.workflowVersionId,
        iterationBudget: 2,
      });
      const advance = (
        observations: Parameters<typeof advanceWorkflow>[0]['observations'],
        completedOutputs?: Parameters<
          typeof advanceWorkflow
        >[0]['completedOutputs'],
      ) =>
        advanceWorkflow({
          ...base,
          checkpoint,
          observations,
          completedOutputs,
        });
      const initial = await advance([]);
      checkpoint = initial.checkpoint;
      const manual = initial.attempts[0];
      if (manual === undefined) throw new Error('manual attempt missing');
      const afterManual = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: manual.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000301',
            attemptNumber: manual.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000301',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000301',
            invocationKey: manual.invocationKey,
            value: {},
          },
        ],
      );
      checkpoint = afterManual.checkpoint;
      const parallel = afterManual.attempts[0];
      if (parallel === undefined) throw new Error('Parallel attempt missing');
      const afterParallel = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: parallel.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000302',
            attemptNumber: parallel.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000302',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000302',
            invocationKey: parallel.invocationKey,
            value: { branchIds: ['branch-01', 'branch-02'] },
          },
        ],
      );
      checkpoint = afterParallel.checkpoint;
      expect(afterParallel.attempts).toHaveLength(1);
      expect(afterParallel.attempts[0]?.nodeId).toBe('loop');
      const loop = afterParallel.attempts[0];
      if (loop === undefined) throw new Error('loop attempt missing');
      const declared = await advance(
        [
          {
            kind: 'outcome',
            sequence: checkpoint.nextEventSequence,
            occurredAt: base.occurredAt,
            invocationKey: loop.invocationKey,
            attemptId: '00000000-0000-4000-8000-000000000303',
            attemptNumber: loop.attemptNumber,
            status: 'succeeded',
            output: {
              kind: 'inline',
              attemptId: '00000000-0000-4000-8000-000000000303',
            },
          },
        ],
        [
          {
            sequence: checkpoint.nextEventSequence,
            attemptId: '00000000-0000-4000-8000-000000000303',
            invocationKey: loop.invocationKey,
            value: { items: [1, 2], iterationCount: 2 },
          },
        ],
      );
      expect(declared.attempts).toHaveLength(maxConcurrency);
      expect(
        new Set(
          declared.attempts.map(
            ({ iterationPath }) => iterationPath?.at(-1)?.ordinal,
          ),
        ).size,
      ).toBe(maxConcurrency);
    },
  );
});
