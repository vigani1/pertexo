import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createWorkflowRunDatabase,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  accept,
  fixture,
  edge,
  node,
  publishGraph,
  runtime,
  limitWorkspace,
  parentGraph,
} from '../../calls/fixtures.js';
import { graph, deciderId } from './fixture.js';

export function registerClosesPendingTaskCancellationWinsRejects(): void {
  it('closes a pending task when cancellation wins and rejects a late decision', async () => {
    const version = await publishGraph(graph());
    const run = await accept(version);
    const workers = await runtime();
    const config = parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.workerUrl),
      max: 2,
    });
    const tasks = createPendingTaskStore(config);
    const runs = createWorkflowRunDatabase(config);
    try {
      let taskId = '';
      await workers.until(async () => {
        const rows = await fixture.workerQuery<{ id: string }>(
          'select id from app.pending_run_tasks where run_id=$1',
          [run.runId],
        );
        expect(rows).toHaveLength(1);
        taskId = rows[0]?.id ?? '';
      });
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: run.runId,
      });
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,consumed_at is not null consumed from app.pending_run_tasks where id=$1',
            [taskId],
          ),
        ).toEqual([{ status: 'canceled', consumed: true }]);
      });
      // Nobody resolved it: the task closed with its canceled run.
      await expect(
        tasks.decide({
          workspaceId: fixture.workspaceId,
          actorId: deciderId,
          taskId,
          decision: 'approved',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'run_closed' });
      await workers.restart();
      expect(
        (
          await runs.get({
            actorId: fixture.actorId,
            workspaceId: fixture.workspaceId,
            runId: run.runId,
          })
        )?.run.status,
      ).toBe('canceled');
    } finally {
      await Promise.all([workers.close(), tasks.close(), runs.close()]);
    }
  }, 30_000);

  it('projects a final Approval result without a new worker attempt and returns a dormant Call slot only after capacity is free', async () => {
    await limitWorkspace(1);
    const leafGraph: WorkflowGraph = {
      settings: { maxRunDurationMs: 60_000 },
      callable: {
        input: { type: 'object', properties: [] },
        resultType: { type: 'string' },
        result: {
          kind: 'node_output',
          nodeId: 'approval',
          path: '$.decision',
        },
      },
      nodes: [
        node('manual', 'core.manual'),
        {
          ...node('approval', 'core.approval'),
          config: approvalConfigSchema.parse({}),
        },
      ],
      edges: [edge('manual', 'approval')],
    };
    const leaf = await publishGraph(leafGraph);
    const parent = await publishGraph({
      ...parentGraph(leaf.pin),
      callable: {
        input: { type: 'object', properties: [] },
        resultType: { type: 'string' },
        result: { kind: 'node_output', nodeId: 'call', path: '$' },
      },
    });
    const run = await accept(parent, {});
    const workers = await runtime();
    const config = parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.workerUrl),
      max: 2,
    });
    const tasks = createPendingTaskStore(config);
    const runs = createWorkflowRunDatabase(config);
    try {
      let taskId = '';
      await workers.until(async () => {
        const rows = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where workspace_id=$1 and status='pending'",
          [fixture.workspaceId],
        );
        expect(rows).toHaveLength(1);
        taskId = rows[0]?.id ?? '';
        expect(
          await fixture.workerQuery(
            'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          ),
        ).toEqual([{ occupied: 0 }]);
      });
      const competitor = await publishGraph({
        ...graph(),
        nodes: [
          node('manual', 'core.manual'),
          { ...node('hold', 'core.wait'), config: { durationSeconds: 60 } },
          node('done', 'core.terminate'),
        ],
        edges: [edge('manual', 'hold'), edge('hold', 'done')],
      });
      const busy = await accept(competitor, {});
      await workers.until(async () => {
        expect(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: busy.runId,
            })
          )?.nodes.find((item) => item.nodeId === 'hold')?.status,
        ).toBe('waiting');
      });
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select timed_wait_started_at is not null parked from app.workflow_runs where id=$1',
            [busy.runId],
          ),
        ).toEqual([{ parked: true }]);
      });
      // A timed Wait holds no workspace slot, so this stands in for a run at work on a step.
      await fixture.ownerQuery(
        'update app.workflow_runs set timed_wait_started_at=null where id=$1',
        [busy.runId],
      );
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
            'select child.status,child.output_ref from app.workflow_calls call join app.workflow_runs child on child.id=call.child_run_id and child.workspace_id=call.workspace_id where call.parent_run_id=$1',
            [run.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'approved' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
          [fixture.workspaceId],
        ),
      ).toEqual([{ occupied: 1 }]);
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: busy.runId,
      });
      await workers.until(async () => {
        expect(
          (
            await runs.get({
              actorId: fixture.actorId,
              workspaceId: fixture.workspaceId,
              runId: run.runId,
            })
          )?.run.status,
        ).toBe('succeeded');
      });
      expect(
        await fixture.workerQuery(
          'select count(*)::int n from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await Promise.all([workers.close(), tasks.close(), runs.close()]);
      await limitWorkspace(5);
    }
  }, 40_000);
}
