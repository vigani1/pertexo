import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowRunDatabase } from '../src/api.js';
import {
  actorId,
  apiBaseUrl,
  databaseUrl,
  parseDatabaseConfig,
  workspaceA,
} from './coordinator-run-store.fixtures.js';
import {
  acceptNativeFixture,
  activateNativeFixture,
  completeNativePhysical,
  createNativeCoordinatorFixtureStore,
  loadNativePlan,
  nativeDescriptions,
} from './support/native-public-store.fixture.js';

beforeAll(activateNativeFixture, 60_000);
const output = { answer: 42 };

describe('native branch and paired Join ownership through public stores', () => {
  it.each(['branch', 'parallel'] as const)(
    'retains exact %s frontier and ledger after real physical facts',
    async (control) => {
      const run = await acceptNativeFixture(
        { kind: 'literal', value: output },
        undefined,
        control,
      );
      const store = createNativeCoordinatorFixtureStore();
      const visited: string[] = [];
      try {
        await store.checkReadiness?.();
        let settled = false;
        for (let revision = 0; revision < 10; revision += 1) {
          const advance = await loadNativePlan(run, store, revision, {
            runInput: output,
            outputs: [],
          });
          const committed = await advance.commit();
          if (committed.kind !== 'committed')
            throw new Error('Native control advance not committed');
          if (advance.plan.checkpoint.runStatus === 'succeeded') {
            if (control === 'parallel')
              expect(advance.plan.checkpoint.joins[0]).toMatchObject({
                policy: { kind: 'all' },
                selectedBranchIds: ['branch-01', 'branch-02'],
                ledger: [
                  expect.objectContaining({
                    branchId: 'branch-01',
                    disposition: 'arrived',
                  }),
                  expect.objectContaining({
                    branchId: 'branch-02',
                    disposition: 'arrived',
                  }),
                ],
              });
            else
              expect(
                advance.plan.checkpoint.schemaVersion === 3 &&
                  advance.plan.checkpoint.branchSelections,
              ).toEqual([
                expect.objectContaining({
                  nodeId: 'condition',
                  selectedOutputPort: 'true',
                }),
              ]);
            settled = true;
            break;
          }
          for (const attempt of committed.admittedAttempts) {
            const planned = advance.plan.attempts.find(
              (planned) => planned.invocationKey === attempt.invocationKey,
            );
            if (planned === undefined)
              throw new Error('Native physical admission not in plan');
            visited.push(planned.nodeId);
            const value =
              planned.nodeId === 'fan'
                ? { branchIds: ['branch-01', 'branch-02'] }
                : planned.nodeId === 'condition'
                  ? { selectedPort: 'true' }
                  : output;
            await completeNativePhysical(run.runId, attempt, value);
          }
        }
        expect(settled).toBe(true);
        if (control === 'branch')
          expect(visited).toEqual(['manual', 'condition', 'selected']);
        else
          expect(visited).toEqual([
            'manual',
            'fan',
            'left',
            'right',
            'join',
            'finish',
          ]);
      } finally {
        await store.close();
      }
    },
  );

  it('cancels never-started native pending branches without inventing physical attempts', async () => {
    const run = await acceptNativeFixture(
      { kind: 'literal', value: output },
      undefined,
      'parallel',
    );
    const store = createNativeCoordinatorFixtureStore();
    try {
      await store.checkReadiness?.();
      for (let revision = 0; revision < 2; revision += 1) {
        const step = await loadNativePlan(run, store, revision);
        const committed = await step.commit();
        if (
          committed.kind !== 'committed' ||
          committed.admittedAttempts[0] === undefined
        )
          throw new Error('Native fan admission missing');
        await completeNativePhysical(
          run.runId,
          committed.admittedAttempts[0],
          revision === 0 ? output : { branchIds: ['branch-01', 'branch-02'] },
        );
      }
      const declaration = await loadNativePlan(run, store, 2);
      const admitted = await declaration.commit();
      expect(admitted).toMatchObject({
        kind: 'committed',
        revision: 3,
      });
      if (
        admitted.kind !== 'committed' ||
        admitted.admittedAttempts.length !== 1 ||
        admitted.admittedAttempts[0] === undefined
      )
        throw new Error('Expected one bounded branch admission');
      await completeNativePhysical(
        run.runId,
        admitted.admittedAttempts[0],
        output,
      );
      const api = createWorkflowRunDatabase(
        parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
        nativeDescriptions.slice(-2),
      );
      try {
        await api.cancel({
          actorId,
          workspaceId: workspaceA,
          runId: run.runId,
          reason: 'Owned pending frontier cancellation',
        });
      } finally {
        await api.close();
      }
      const stopped = await loadNativePlan(run, store, 3);
      expect(stopped.plan.checkpoint.runStatus).toBe('canceled');
      expect(stopped.plan.attempts).toEqual([]);
      expect(
        stopped.plan.checkpoint.invocations.filter(
          (entry) => entry.nodeId === 'right',
        ),
      ).toEqual([
        expect.objectContaining({ status: 'canceled', attemptNumber: 0 }),
      ]);
      await expect(stopped.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 4,
      });
    } finally {
      await store.close();
    }
  });
});
