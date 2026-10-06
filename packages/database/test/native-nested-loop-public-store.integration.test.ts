import { beforeAll, describe, expect, it } from 'vitest';
import { createWorkflowRunDatabase } from '../src/api.js';
import {
  actorId,
  apiBaseUrl,
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
const output = { answer: 42 };

describe('native nested For Each declaration ownership through public stores', () => {
  it.each(['canceled', 'continued'] as const)(
    'preserves ancestor scope when an inner declaration is %s',
    async (outcome) => {
      const run = await acceptNativeFixture(
        { kind: 'literal', value: output },
        undefined,
        'nested',
      );
      const store = createNativeCoordinatorFixtureStore();
      try {
        await store.checkReadiness?.();
        for (let revision = 0; revision < 3; revision += 1) {
          const step = await loadNativePlan(run, store, revision);
          const committed = await step.commit();
          if (
            committed.kind !== 'committed' ||
            committed.admittedAttempts.length !== 1 ||
            committed.admittedAttempts[0] === undefined
          )
            throw new Error('Expected one bounded nested physical admission');
          const planned = step.plan.attempts.find(
            (entry) =>
              entry.invocationKey ===
              committed.admittedAttempts[0]?.invocationKey,
          );
          expect(planned?.nodeId).toBe(['manual', 'loop', 'inner'][revision]);
          await completeNativePhysical(
            run.runId,
            committed.admittedAttempts[0],
            revision === 0
              ? output
              : revision === 1
                ? { items: [1, 2], iterationCount: 2 }
                : { items: [3, 4], iterationCount: 2 },
          );
        }
        if (outcome === 'canceled') {
          const api = createWorkflowRunDatabase(
            parseDatabaseConfig({ connectionString: databaseUrl(apiBaseUrl) }),
            nativeDescriptions.slice(-2),
          );
          try {
            await api.cancel({
              actorId,
              workspaceId: workspaceA,
              runId: run.runId,
              reason: 'Owned nested declaration stop',
            });
          } finally {
            await api.close();
          }
        }
        const settlement = await loadNativePlan(run, store, 3);
        if (outcome === 'canceled') {
          expect(settlement.plan.checkpoint.runStatus).toBe('canceled');
          expect(settlement.plan.attempts).toEqual([]);
          expect(settlement.plan.checkpoint.loops).toHaveLength(1);
        } else expect(settlement.plan.checkpoint.loops).toHaveLength(2);
        expect(
          settlement.plan.checkpoint.loops.find(
            (loop) => loop.loopId === 'loop',
          ),
        ).toMatchObject({
          loopId: 'loop',
          collectionSize: 2,
        });
        const inner = settlement.plan.checkpoint.invocations.find(
          (entry) => entry.nodeId === 'inner',
        );
        expect(inner).toMatchObject({
          status: outcome === 'canceled' ? 'canceled' : 'waiting',
          iterationPath: [{ loopNodeId: 'loop', ordinal: 0 }],
        });
        const admitted = await settlement.commit();
        expect(admitted).toMatchObject({
          kind: 'committed',
          revision: 4,
        });
        if (outcome === 'continued') {
          if (admitted.kind !== 'committed')
            throw new Error('Nested declaration not committed');
          let pending = admitted.admittedAttempts;
          let terminal = false;
          const scopes: unknown[] = [];
          for (let revision = 4; revision < 20; revision += 1) {
            for (const attempt of pending) {
              // Current persisted node scope is independently read, never copied
              // from a proposed checkpoint or trusted worker summary.
              const row = await asRuntime(workerBaseUrl, workspaceA, (client) =>
                client.query<{ node_id: string; branch_context: unknown }>(
                  'select node_id,branch_context from app.node_runs where workspace_id=$1 and id=$2',
                  [workspaceA, attempt.nodeRunId],
                ),
              );
              const node = row.rows[0];
              if (node === undefined)
                throw new Error('Nested admitted node missing');
              if (node.node_id === 'deep') scopes.push(node.branch_context);
              await completeNativePhysical(
                run.runId,
                attempt,
                node.node_id === 'inner'
                  ? { items: [3, 4], iterationCount: 2 }
                  : output,
              );
            }
            const next = await loadNativePlan(run, store, revision, {
              runInput: output,
              outputs: [],
            });
            const committed = await next.commit();
            if (committed.kind !== 'committed')
              throw new Error('Nested continuation not committed');
            if (next.plan.checkpoint.runStatus === 'succeeded') {
              expect(next.plan.checkpoint.loops).toHaveLength(3);
              expect(
                next.plan.checkpoint.loops.every(
                  (loop) =>
                    loop.activeOrdinals.length === 0 &&
                    loop.terminalOrdinals.length === 2,
                ),
              ).toBe(true);
              terminal = true;
              break;
            }
            pending = committed.admittedAttempts;
          }
          expect(terminal).toBe(true);
          expect(scopes).toEqual(
            [0, 1].flatMap((outer) =>
              [0, 1].map((inner) => ({
                branchPath: [],
                iterationPath: [
                  { loopNodeId: 'loop', ordinal: outer },
                  { loopNodeId: 'inner', ordinal: inner },
                ],
              })),
            ),
          );
        }
        const physical = await asRuntime(workerBaseUrl, workspaceA, (client) =>
          client.query<{
            node_status: string;
            attempt_status: string;
            output_ref: unknown;
          }>(
            `select node.status node_status,attempt.status attempt_status,attempt.output_ref from app.node_runs node
          join app.node_attempts attempt on attempt.workspace_id=node.workspace_id and attempt.id=node.current_attempt_id
          where node.workspace_id=$1 and node.workflow_run_id=$2 and node.node_id='inner'`,
            [workspaceA, run.runId],
          ),
        );
        expect(physical.rows).toHaveLength(outcome === 'canceled' ? 1 : 2);
        for (const row of physical.rows)
          expect(row).toEqual({
            node_status: outcome === 'canceled' ? 'canceled' : 'succeeded',
            attempt_status: 'succeeded',
            output_ref: {
              schemaVersion: 1,
              kind: 'inline',
              value: { items: [3, 4], iterationCount: 2 },
            },
          });
      } finally {
        await store.close();
      }
    },
  );
});
