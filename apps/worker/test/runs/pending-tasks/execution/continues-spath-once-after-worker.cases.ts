import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createDueNodeWakeupScanner,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  accept,
  fixture,
  publishGraph,
  runtime,
  limitWorkspace,
  parentGraph,
} from '../../calls/fixtures.js';
import { graph, deciderId } from './fixture.js';

export function registerContinuesSPathOnceAfterWorker(): void {
  it.each(['approved', 'rejected'] as const)(
    'continues the %s path once after worker restart',
    async (decision) => {
      const version = await publishGraph(graph());
      const run = await accept(version);
      const workers = await runtime();
      const tasks = createPendingTaskStore(
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 2,
        }),
      );
      try {
        let taskId: string | undefined;
        await workers.until(async () => {
          const rows = await fixture.workerQuery<{ id: string }>(
            "select id from app.pending_run_tasks where run_id=$1 and status='pending'",
            [run.runId],
          );
          expect(rows).toHaveLength(1);
          taskId = rows[0]?.id;
          expect(
            await fixture.workerQuery(
              'select status,human_wait_started_at is not null paused,deadline_at from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'waiting', paused: true, deadline_at: null }]);
        });
        if (taskId === undefined) throw new Error('Missing approval');
        await workers.restart();
        await tasks.decide({
          workspaceId: fixture.workspaceId,
          actorId: deciderId,
          taskId,
          decision,
          comment: 'Runtime proof',
          idempotencyKey: randomUUID(),
        });
        await workers.until(async () => {
          expect(
            await fixture.workerQuery(
              'select status,output_ref from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([
            {
              status: 'succeeded',
              output_ref: null,
            },
          ]);
        });
        expect(
          await fixture.workerQuery(
            'select output_ref from app.node_runs where workflow_run_id=$1 and node_id=$2',
            [run.runId, decision],
          ),
        ).toEqual([
          { output_ref: { kind: 'inline', value: { result: decision } } },
        ]);
        expect(
          await fixture.workerQuery(
            "select count(*)::int n from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and node.node_id='approval'",
            [run.runId],
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await fixture.workerQuery(
            'select status,consumed_at is not null consumed from app.pending_run_tasks where run_id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: decision, consumed: true }]);
      } finally {
        await Promise.all([workers.close(), tasks.close()]);
      }
    },
    30_000,
  );

  it('expires through the existing due scanner and follows its failure route without another attempt', async () => {
    const version = await publishGraph(graph(true));
    const run = await accept(version);
    const workers = await runtime();
    const due = createDueNodeWakeupScanner(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 1,
      }),
    );
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.pending_run_tasks where run_id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'pending' }]);
      });
      await workers.pause();
      await fixture.ownerQuery(
        "update app.pending_run_tasks set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
        [run.runId],
      );
      await fixture.ownerQuery(
        "update app.node_runs set resume_at=clock_timestamp()-interval '1 second' where workflow_run_id=$1 and control_kind='human_task'",
        [run.runId],
      );
      await due.claimDueWakeups(20);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref,handled_failure_count from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: null,
            handled_failure_count: 1,
          },
        ]);
      });
    } finally {
      await Promise.all([workers.close(), due.close()]);
    }
  }, 30_000);

  it('pauses and resumes a nested Call chain within one shared slot and keeps final decision output', async () => {
    await limitWorkspace(1);
    const leafGraph: WorkflowGraph = {
      ...graph(),
      callable: {
        input: { type: 'object', properties: [] },
        resultType: { type: 'string' },
        result: {
          kind: 'node_output',
          nodeId: 'approval',
          path: '$.decision',
        },
      },
    };
    const leaf = await publishGraph(leafGraph);
    const middle = await publishGraph({
      ...parentGraph(leaf.pin),
      callable: {
        resultType: { type: 'string' },
        result: { kind: 'node_output', nodeId: 'call', path: '$' },
        input: { type: 'object', properties: [] },
      },
    });
    const root = await publishGraph({
      ...parentGraph(middle.pin),
      callable: {
        resultType: { type: 'string' },
        result: { kind: 'node_output', nodeId: 'call', path: '$' },
        input: { type: 'object', properties: [] },
      },
    });
    const run = await accept(root, {});
    const workers = await runtime();
    const tasks = createPendingTaskStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
        max: 2,
      }),
    );
    try {
      let taskId: string | undefined;
      await workers.until(async () => {
        const rows = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where workspace_id=$1 and status='pending'",
          [fixture.workspaceId],
        );
        expect(rows).toHaveLength(1);
        taskId = rows[0]?.id;
        expect(
          await fixture.workerQuery(
            "select count(*)::int n from app.workflow_runs where workspace_id=$1 and human_wait_started_at is not null and status='waiting'",
            [fixture.workspaceId],
          ),
        ).toEqual([{ n: 3 }]);
        expect(
          await fixture.workerQuery(
            'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          ),
        ).toEqual([{ occupied: 0 }]);
      });
      if (taskId === undefined) throw new Error('Missing nested task');
      await workers.restart();
      await tasks.decide({
        workspaceId: fixture.workspaceId,
        actorId: deciderId,
        taskId,
        decision: 'approved',
        idempotencyKey: randomUUID(),
      });
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'approved' },
          },
        ]);
      });
    } finally {
      await Promise.all([workers.close(), tasks.close()]);
      await limitWorkspace(5);
    }
  }, 40_000);
}
