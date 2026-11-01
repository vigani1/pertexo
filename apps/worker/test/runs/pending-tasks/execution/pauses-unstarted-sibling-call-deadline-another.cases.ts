import { randomUUID } from 'node:crypto';
import { it, expect } from 'vitest';

import { createPendingTaskStore } from '@pertexo/core/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import {
  accept,
  childGraph,
  fixture,
  edge,
  node,
  publishGraph,
  runtime,
  limitWorkspace,
} from '../../calls/fixtures.js';
import { graph, deciderId } from './fixture.js';

export function registerPausesUnstartedSiblingCallDeadlineAnother(): void {
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
}
