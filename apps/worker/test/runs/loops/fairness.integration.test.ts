import { createWorkflowRunDatabase } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accept, fixture, publishGraph, runtime } from '../calls/fixtures.js';
import { acceptQuietWorkspace, callable, maximumLoop } from './fixtures.js';

const integration = fixture.enabled ? describe : describe.skip;
integration('maximum loops preserve ordinary run fairness', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  const runs = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.apiUrl),
      max: 2,
    }),
  );
  afterAll(() => runs.close());

  it.each([
    ['parallel', 'canceled'],
    ['nested', 'canceled'],
    ['call', 'canceled'],
    ['parallel', 'timed_out'],
  ] as const)(
    '%s yields to quiet runs in the same and another workspace, then settles %s',
    async (kind, control) => {
      const child = await publishGraph(callable);
      const busy = await publishGraph(maximumLoop(kind, child.pin));
      const quiet = await publishGraph({
        settings: {},
        nodes: callable.nodes,
        edges: [],
      });
      const accepted = await accept(busy, {});
      const workers = await runtime();
      let occupied = 0;
      try {
        await workers.until(async () => {
          const [progress] = await fixture.workerQuery<{ count: number }>(
            kind === 'call'
              ? 'select count(*)::int count from app.workflow_calls where parent_run_id=$1'
              : "select count(*)::int count from app.node_runs where workflow_run_id=$1 and node_id='body'",
            [accepted.runId],
          );
          expect(progress?.count).toBeGreaterThan(0);
        }, 30_000);
        const sameWorkspace = await accept(quiet, {});
        const other = await acceptQuietWorkspace();
        const started = performance.now();
        await workers.until(async () => {
          const [capacity] = await fixture.workerQuery<{ occupied: number }>(
            'select (active_runs+reserved_active_slots)::int occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          );
          occupied = Math.max(occupied, capacity?.occupied ?? 0);
          expect(occupied).toBeLessThanOrEqual(5);
          expect(
            (
              await runs.get({
                actorId: fixture.actorId,
                workspaceId: fixture.workspaceId,
                runId: sameWorkspace.runId,
              })
            )?.run.status,
          ).toBe('succeeded');
          expect(
            (
              await runs.get({
                actorId: fixture.actorId,
                workspaceId: other.workspaceId,
                runId: other.runId,
              })
            )?.run.status,
          ).toBe('succeeded');
          const [progress] = await fixture.workerQuery<{ count: number }>(
            kind === 'call'
              ? 'select count(*)::int count from app.workflow_calls where parent_run_id=$1'
              : "select count(*)::int count from app.node_runs where workflow_run_id=$1 and node_id='body'",
            [accepted.runId],
          );
          expect(progress?.count).toBeGreaterThan(0);
          expect(['running', 'waiting']).toContain(
            (
              await runs.get({
                actorId: fixture.actorId,
                workspaceId: fixture.workspaceId,
                runId: accepted.runId,
              })
            )?.run.status,
          );
        }, 30_000);
        const [state] = await fixture.workerQuery<{ bytes: number }>(
          'select octet_length(scheduler_state::text) bytes from app.run_checkpoints where workflow_run_id=$1',
          [accepted.runId],
        );
        expect(state?.bytes).toBeLessThan(262_144);
        process.stdout.write(
          `LOOP_FAIRNESS=${JSON.stringify({ scenario: kind, control, quietMillis: Math.round(performance.now() - started), occupied, checkpointBytes: state?.bytes })}\n`,
        );
      } finally {
        if (control === 'canceled')
          await runs.cancel({
            workspaceId: fixture.workspaceId,
            actorId: fixture.actorId,
            runId: accepted.runId,
          });
        else
          await fixture.ownerQuery(
            'update app.workflow_runs set deadline_at=clock_timestamp() where id=$1',
            [accepted.runId],
          );
        try {
          await workers.until(async () => {
            expect(
              (
                await runs.get({
                  actorId: fixture.actorId,
                  workspaceId: fixture.workspaceId,
                  runId: accepted.runId,
                })
              )?.run.status,
            ).toBe(control);
            expect(
              await fixture.workerQuery(
                'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
                [fixture.workspaceId],
              ),
            ).toEqual([]);
          }, 30_000);
          const [dispatch] = await fixture.workerQuery<{ dispatched: number }>(
            `select count(*)::int dispatched from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id and node.workspace_id=attempt.workspace_id join app.workflow_runs run on run.id=node.workflow_run_id and run.workspace_id=node.workspace_id where run.id=$1 and attempt.started_at >= coalesce(run.cancel_requested_at,run.deadline_at) and attempt.dispatch_marked_at is not null`,
            [accepted.runId],
          );
          expect(dispatch?.dispatched).toBe(0);
        } finally {
          await workers.close();
        }
      }
    },
    60_000,
  );
});
