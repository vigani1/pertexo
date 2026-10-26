import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';
import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  createDueNodeWakeupScanner,
  createPendingTaskStore,
  createWorkflowRunDatabase,
} from '@pertexo/database/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  accept,
  edge,
  fixture,
  limitWorkspace,
  node,
  publishGraph,
  runtime,
} from '../../calls/fixtures.js';
import { deciderId } from './fixture.js';

/** Approval → Approved / Rejected / Timed out, each ending the run. */
function timedOutGraph(): WorkflowGraph {
  return {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      node('manual', 'core.manual'),
      {
        ...node('approval', 'core.approval'),
        config: approvalConfigSchema.parse({ onExpiry: 'continue' }),
      },
      ...['approved', 'rejected'].map((id) => ({
        ...node(id, 'core.terminate'),
        inputMappings: { result: { kind: 'literal' as const, value: id } },
      })),
      {
        ...node('escalate', 'core.terminate'),
        inputMappings: {
          result: {
            kind: 'node_output' as const,
            nodeId: 'approval',
            path: '$.timedOut',
          },
        },
      },
    ],
    edges: [
      edge('manual', 'approval'),
      edge('approval', 'approved', 'approved'),
      edge('approval', 'rejected', 'rejected'),
      edge('approval', 'escalate', 'timed_out'),
    ],
  };
}

async function expireOpenTask(runId: string) {
  await fixture.ownerQuery(
    "update app.pending_run_tasks set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 second' where run_id=$1",
    [runId],
  );
  await fixture.ownerQuery(
    "update app.node_runs set resume_at=clock_timestamp()-interval '1 second' where workflow_run_id=$1 and control_kind='human_task'",
    [runId],
  );
}

function workerDatabase() {
  return parseDatabaseConfig({
    connectionString: fixture.databaseUrl(fixture.workerUrl),
    max: 2,
  });
}

export function registerContinuesTimedOutPath(): void {
  it('continues on Timed out after expiry, runs the step there once and refuses a late decision', async () => {
    const version = await publishGraph(timedOutGraph());
    const run = await accept(version);
    const workers = await runtime();
    const config = workerDatabase();
    const due = createDueNodeWakeupScanner(config);
    const tasks = createPendingTaskStore(config);
    try {
      let taskId = '';
      await workers.until(async () => {
        const rows = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where run_id=$1 and status='pending'",
          [run.runId],
        );
        expect(rows).toHaveLength(1);
        taskId = rows[0]?.id ?? '';
      });
      await workers.pause();
      await expireOpenTask(run.runId);
      await due.claimDueWakeups(20);
      await workers.restart();
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,handled_failure_count from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded', handled_failure_count: 0 }]);
      });
      expect(
        await fixture.workerQuery(
          'select node_id,status,output_ref from app.node_runs where workflow_run_id=$1 and node_id in ($2,$3,$4) order by node_id',
          [run.runId, 'approved', 'escalate', 'rejected'],
        ),
      ).toEqual([
        { node_id: 'approved', status: 'skipped', output_ref: null },
        {
          node_id: 'escalate',
          status: 'succeeded',
          output_ref: { kind: 'inline', value: { result: true } },
        },
        { node_id: 'rejected', status: 'skipped', output_ref: null },
      ]);
      const [approval] = await fixture.workerQuery<{
        status: string;
        safe_error_code: string | null;
        output: Record<string, unknown>;
      }>(
        "select status,safe_error_code,output_ref->'value' output from app.node_runs where workflow_run_id=$1 and node_id='approval'",
        [run.runId],
      );
      expect(approval).toMatchObject({
        status: 'succeeded',
        safe_error_code: null,
        output: { timedOut: true },
      });
      expect(
        await fixture.workerQuery(
          "select count(*)::int n from app.node_attempts attempt join app.node_runs node on node.id=attempt.node_run_id where node.workflow_run_id=$1 and node.node_id='approval'",
          [run.runId],
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        await fixture.workerQuery(
          'select status,consumed_at is not null consumed from app.pending_run_tasks where id=$1',
          [taskId],
        ),
      ).toEqual([{ status: 'expired', consumed: true }]);
      await expect(
        tasks.decide({
          workspaceId: fixture.workspaceId,
          actorId: deciderId,
          taskId,
          decision: 'approved',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'expired' });
    } finally {
      await Promise.all([workers.close(), due.close(), tasks.close()]);
    }
  }, 30_000);

  it('settles the timeout without a worker slot and runs the Timed out step once capacity returns', async () => {
    await limitWorkspace(1);
    const version = await publishGraph(timedOutGraph());
    const run = await accept(version);
    const workers = await runtime();
    const config = workerDatabase();
    const due = createDueNodeWakeupScanner(config);
    const runs = createWorkflowRunDatabase(config);
    const nodeStatus = async (nodeId: string) =>
      (
        await runs.get({
          actorId: fixture.actorId,
          workspaceId: fixture.workspaceId,
          runId: run.runId,
        })
      )?.nodes.find((item) => item.nodeId === nodeId)?.status;
    try {
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            "select count(*)::int n from app.pending_run_tasks where run_id=$1 and status='pending'",
            [run.runId],
          ),
        ).toEqual([{ n: 1 }]);
      });
      const competitor = await publishGraph({
        settings: { maxRunDurationMs: 60_000 },
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
      await expireOpenTask(run.runId);
      await due.claimDueWakeups(20);
      await workers.until(async () => {
        expect(await nodeStatus('approval')).toBe('succeeded');
        expect(
          await fixture.workerQuery(
            'select status,consumed_at is not null consumed from app.pending_run_tasks where run_id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'expired', consumed: true }]);
      });
      expect(await nodeStatus('escalate')).not.toBe('succeeded');
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: busy.runId,
      });
      await workers.until(async () => {
        expect(await nodeStatus('escalate')).toBe('succeeded');
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
    } finally {
      await Promise.all([workers.close(), due.close(), runs.close()]);
      await limitWorkspace(5);
    }
  }, 40_000);
}
