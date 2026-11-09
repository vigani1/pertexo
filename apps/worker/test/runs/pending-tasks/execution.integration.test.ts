import { maintenanceConfig } from '../../../../../infrastructure/testing/worker-databases.mjs';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import {
  fixture,
  accept,
  publishGraph,
  runtime,
  limitWorkspace,
  parentGraph,
  edge,
  node,
  childGraph,
} from '../calls/calls.fixture.js';
import {
  prepareApprovalThroughRealWorkersDurableTasks,
  graph,
  deciderId,
} from './pending-tasks-execution.fixture.js';
import { randomUUID } from 'node:crypto';
import {
  approvalConfigSchema,
  type WorkflowGraph,
} from '@pertexo/workflow-model';
import {
  createPendingTaskStore,
  createDueNodeWakeupScanner,
  createWorkflowRunDatabase,
} from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';

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

describe.runIf(fixture.enabled)(
  'Approval through real workers, durable tasks and transport',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
    beforeAll(prepareApprovalThroughRealWorkersDurableTasks);
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
        maintenanceConfig(
          parseDatabaseConfig({
            connectionString: fixture.databaseUrl(fixture.workerUrl),
            max: 1,
          }),
        ),
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

    it('pauses an unstarted sibling Call deadline while another child awaits a human', async () => {
      await limitWorkspace(1);
      const approvalChild = await publishGraph({
        ...graph(),
        callable: {
          input: {
            type: 'object',
            properties: [
              { name: 'name', valueType: { type: 'string' }, required: true },
            ],
          },
          resultType: { type: 'string' },
          result: {
            kind: 'node_output',
            nodeId: 'approval',
            path: '$.decision',
          },
        },
      });
      const ordinaryChild = await publishGraph({
        ...childGraph(),
        settings: { maxRunDurationMs: 5000 },
      });
      const call = (id: string, target: typeof approvalChild.pin) => ({
        ...node(id, 'core.call'),
        config: { target: { ...target } },
        inputMappings: {
          input: { kind: 'literal' as const, value: { name: 'Ada' } },
        },
      });
      const parent = await publishGraph({
        settings: { maxRunDurationMs: 60_000 },
        nodes: [
          node('manual', 'core.manual'),
          {
            ...node('parallel', 'core.parallel'),
            config: {
              branches: [{ id: 'branch-01' }, { id: 'branch-02' }],
              maxConcurrency: 2,
            },
          },
          call('call-a', approvalChild.pin),
          call('call-b', ordinaryChild.pin),
          {
            ...node('merge', 'core.merge'),
            config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
          },
          node('finish', 'core.terminate'),
        ],
        edges: [
          edge('manual', 'parallel'),
          edge('parallel', 'call-a', 'branch-01'),
          edge('parallel', 'call-b', 'branch-02'),
          {
            ...edge('call-a', 'merge'),
            target: { nodeId: 'merge', port: 'branch-01' },
          },
          {
            ...edge('call-b', 'merge'),
            target: { nodeId: 'merge', port: 'branch-02' },
          },
          edge('merge', 'finish'),
        ],
      });
      const run = await accept(parent, {});
      const workers = await runtime();
      const tasks = createPendingTaskStore(
        parseDatabaseConfig({
          connectionString: fixture.databaseUrl(fixture.workerUrl),
          max: 2,
        }),
      );
      try {
        let taskId = '';
        await workers.until(async () => {
          const rows = await fixture.workerQuery<{ id: string }>(
            "select task.id from app.pending_run_tasks task join app.workflow_calls call on call.child_run_id=task.run_id and call.workspace_id=task.workspace_id where call.parent_run_id=$1 and task.status='pending'",
            [run.runId],
          );
          expect(rows).toHaveLength(1);
          taskId = rows[0]?.id ?? '';
          expect(
            await fixture.workerQuery(
              'select status,child_run_id is not null allocated from app.workflow_calls where parent_run_id=$1 order by invocation_key',
              [run.runId],
            ),
          ).toEqual([
            { status: 'accepted', allocated: true },
            { status: 'pending', allocated: false },
          ]);
          expect(
            await fixture.workerQuery(
              'select human_wait_started_at is not null paused from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ paused: true }]);
        });
        await new Promise((resolve) => setTimeout(resolve, 5200));
        expect(
          await fixture.workerQuery(
            "select deadline_at<clock_timestamp() expired from app.workflow_calls where parent_run_id=$1 and status='pending'",
            [run.runId],
          ),
        ).toEqual([{ expired: true }]);
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
              'select status from app.workflow_runs where id=$1',
              [run.runId],
            ),
          ).toEqual([{ status: 'succeeded' }]);
        });
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_calls where parent_run_id=$1 order by invocation_key',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }, { status: 'succeeded' }]);
      } finally {
        await Promise.all([workers.close(), tasks.close()]);
        await limitWorkspace(5);
      }
    }, 40_000);

    it('continues on Timed out after expiry, runs the step there once and refuses a late decision', async () => {
      const version = await publishGraph(timedOutGraph());
      const run = await accept(version);
      const workers = await runtime();
      const config = workerDatabase();
      const due = createDueNodeWakeupScanner(maintenanceConfig(config));
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
      const due = createDueNodeWakeupScanner(maintenanceConfig(config));
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
  },
);
