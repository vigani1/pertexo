import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowRunDatabase } from '../src/api.js';
import {
  actorId,
  apiBaseUrl,
  asAdmin,
  asRuntime,
  databaseUrl,
  parseDatabaseConfig,
  workerBaseUrl,
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
const result = { answer: 42 };

async function prepareLoopDeclaration() {
  const run = await acceptNativeFixture(
    { kind: 'literal', value: result },
    undefined,
    'loop',
  );
  const store = createNativeCoordinatorFixtureStore();
  try {
    await store.checkReadiness?.();
    const manual = await (await loadNativePlan(run, store, 0)).commit();
    if (manual.kind !== 'committed' || manual.admittedAttempts[0] === undefined)
      throw new Error('Manual admission missing');
    await completeNativePhysical(run.runId, manual.admittedAttempts[0], result);
    const loop = await (await loadNativePlan(run, store, 1)).commit();
    if (loop.kind !== 'committed' || loop.admittedAttempts[0] === undefined)
      throw new Error('Loop declaration admission missing');
    return { run, store, physical: loop.admittedAttempts[0] };
  } catch (error) {
    await store.close();
    throw error;
  }
}

describe('native For Each control settlement over real public stores', () => {
  it('cancels an initialized loop without admitting its remaining ordinal', async () => {
    const { run, store, physical } = await prepareLoopDeclaration();
    try {
      await completeNativePhysical(run.runId, physical, {
        items: [1, 2],
        iterationCount: 2,
      });
      const declaration = await loadNativePlan(run, store, 2);
      const admitted = await declaration.commit();
      if (
        admitted.kind !== 'committed' ||
        admitted.admittedAttempts.length !== 1 ||
        admitted.admittedAttempts[0] === undefined
      )
        throw new Error('Expected one bounded loop body admission');
      await completeNativePhysical(
        run.runId,
        admitted.admittedAttempts[0],
        result,
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
          reason: 'Owned initialized loop cancellation',
        });
      } finally {
        await api.close();
      }
      const stopped = await loadNativePlan(run, store, 3);
      expect(stopped.plan.checkpoint.runStatus).toBe('canceled');
      expect(stopped.plan.checkpoint.loops).toEqual([
        expect.objectContaining({
          collectionSize: 2,
          terminalStatus: 'canceled',
          activeOrdinals: [],
        }),
      ]);
      expect(stopped.plan.attempts).toEqual([]);
      await expect(stopped.commit()).resolves.toMatchObject({
        kind: 'committed',
        revision: 4,
      });
      const physicalBodies = await asRuntime(
        workerBaseUrl,
        workspaceA,
        (client) =>
          client.query<{ count: number; status: string }>(
            `select count(*)::int count,attempt.status from app.node_runs node
          join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
          where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id='body' group by attempt.status`,
            [workspaceA, run.runId],
          ),
      );
      expect(physicalBodies.rows).toEqual([{ count: 1, status: 'succeeded' }]);
    } finally {
      await store.close();
    }
  });

  it.each([0, 2, 3])(
    'independently validates a physical collection of %s members at the two-member bound',
    async (size) => {
      const { run, store, physical } = await prepareLoopDeclaration();
      try {
        await completeNativePhysical(run.runId, physical, {
          items: Array.from({ length: size }, (_, i) => i),
          iterationCount: size,
        });
        const declaration = await loadNativePlan(run, store, 2);
        const next = await declaration.commit();
        expect(next).toMatchObject({ kind: 'committed', revision: 3 });
        if (size > 2) {
          expect(declaration.plan.checkpoint.runStatus).toBe('failed');
          expect(declaration.plan.events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: 'node.failed',
                reasonCode: 'loop_limit_exceeded',
              }),
            ]),
          );
        } else {
          expect(declaration.plan.checkpoint.loops).toHaveLength(1);
          expect(declaration.plan.checkpoint.loops[0]).toMatchObject({
            collectionSize: size,
            maxIterations: 2,
          });
          if (next.kind !== 'committed')
            throw new Error('Accepted loop not committed');
          let revision = 3;
          let pending = next.admittedAttempts;
          let terminal = false;
          for (let pass = 0; pass < 8; pass += 1) {
            for (const attempt of pending)
              await completeNativePhysical(run.runId, attempt, result);
            const advance = await loadNativePlan(run, store, revision, {
              runInput: result,
              outputs: [],
            });
            const committed = await advance.commit();
            if (committed.kind !== 'committed')
              throw new Error('Loop continuation not committed');
            revision += 1;
            if (advance.plan.checkpoint.runStatus === 'succeeded') {
              expect(
                advance.plan.checkpoint.loops[0]?.terminalOrdinals,
              ).toEqual(Array.from({ length: size }, (_, i) => i));
              terminal = true;
              break;
            }
            pending = committed.admittedAttempts;
          }
          expect(terminal).toBe(true);
        }
        const retained = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            node_status: string;
            attempt_status: string;
            output_ref: unknown;
            physical_output_ref: unknown;
          }>(
            `select node.status node_status,attempt.status attempt_status,node.output_ref,attempt.output_ref physical_output_ref from app.node_runs node
         join app.node_attempts attempt on attempt.id=node.current_attempt_id and attempt.workspace_id=node.workspace_id
         where node.workspace_id=$1 and node.id=$2`,
            [workspaceA, physical.nodeRunId],
          ),
        );
        expect(retained.rows).toEqual([
          {
            node_status: size > 2 ? 'failed' : 'succeeded',
            attempt_status: 'succeeded',
            output_ref:
              size > 2
                ? null
                : {
                    schemaVersion: 1,
                    kind: 'inline',
                    value: {
                      items: Array.from({ length: size }, (_, i) => i),
                      iterationCount: size,
                    },
                  },
            physical_output_ref: {
              schemaVersion: 1,
              kind: 'inline',
              value: {
                items: Array.from({ length: size }, (_, i) => i),
                iterationCount: size,
              },
            },
          },
        ]);
      } finally {
        await store.close();
      }
    },
  );

  it.each(['canceled', 'timed_out'] as const)(
    'preserves physical attempt success and accepted bytes when %s preempts a fresh loop declaration',
    async (status) => {
      const { run, store, physical } = await prepareLoopDeclaration();
      try {
        await completeNativePhysical(run.runId, physical, {
          items: [1, 2],
          iterationCount: 2,
        });
        if (status === 'canceled') {
          const api = createWorkflowRunDatabase(
            parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
            nativeDescriptions.slice(-2),
          );
          try {
            await api.cancel({
              actorId,
              workspaceId: workspaceA,
              runId: run.runId,
              reason: 'Owned native declaration cancellation',
            });
          } finally {
            await api.close();
          }
        } else {
          // Owned clock fixture, not a relaxed runtime deadline or test timeout.
          await asAdmin((client) =>
            client.query(
              `update app.workflow_runs set created_at=clock_timestamp()-interval '2 seconds', input_ref_expires_at=clock_timestamp()+interval '29 days',
          deadline_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and id=$2`,
              [workspaceA, run.runId],
            ),
          );
        }
        const stopped = await loadNativePlan(run, store, 2);
        expect(stopped.plan.checkpoint.runStatus).toBe(status);
        expect(stopped.plan.attempts).toEqual([]);
        expect(stopped.plan.checkpoint.loops).toEqual([]);
        await expect(stopped.commit()).resolves.toMatchObject({
          kind: 'committed',
          revision: 3,
        });
        const retained = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{ status: string; output_ref: unknown }>(
            `select node.status,node.output_ref,attempt.status attempt_status from app.node_runs node
              join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
              where node.workspace_id=$1 and node.id=$2`,
            [workspaceA, physical.nodeRunId],
          ),
        );
        expect(retained.rows).toEqual([
          {
            status,
            attempt_status: 'succeeded',
            output_ref: {
              schemaVersion: 1,
              kind: 'inline',
              value: { items: [1, 2], iterationCount: 2 },
            },
          },
        ]);
      } finally {
        await store.close();
      }
    },
  );
});
