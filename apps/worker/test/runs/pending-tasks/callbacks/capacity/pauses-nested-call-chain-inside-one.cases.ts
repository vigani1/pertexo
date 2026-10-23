import { expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';

import {
  accept,
  edge,
  fixture,
  limitWorkspace,
  node,
  parentGraph,
  publishGraph,
  runtime,
} from '../../../calls/fixtures.js';
import { callbackResources } from '../fixtures.js';
import { wait, reply, loop } from './fixture.js';

export function registerPausesNestedCallChainInsideOne(): void {
  it('pauses a nested Call chain inside one slot and resumes the original parent', async () => {
    await limitWorkspace(1);
    const leaf: WorkflowGraph = {
      settings: { maxRunDurationMs: 60_000 },
      nodes: [node('manual', 'core.manual'), wait('wait')],
      edges: [edge('manual', 'wait')],
      callable: {
        input: {
          type: 'object',
          properties: [
            { name: 'name', valueType: { type: 'string' }, required: true },
          ],
        },
        resultType: { type: 'string' },
        result: { kind: 'node_output', nodeId: 'wait', path: '$.body.value' },
      },
    };
    const child = await publishGraph(leaf);
    const middle = await publishGraph(parentGraph(child.pin));
    const parent = await publishGraph(parentGraph(middle.pin));
    const run = await accept(parent);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let id = '';
      await workers.until(async () => {
        const tasks = await fixture.workerQuery<{ id: string }>(
          "select id from app.pending_run_tasks where workspace_id=$1 and status='pending'",
          [fixture.workspaceId],
        );
        expect(tasks).toHaveLength(1);
        id = tasks[0]?.id ?? '';
        expect(
          await fixture.workerQuery(
            "select count(*)::int n from app.workflow_runs where workspace_id=$1 and status='waiting' and human_wait_started_at is not null",
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
      await workers.restart();
      await reply(resources, id);
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status,output_ref from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([
          {
            status: 'succeeded',
            output_ref: { kind: 'inline', value: 'resumed' },
          },
        ]);
      });
      expect(
        await fixture.workerQuery(
          'select count(*)::int n from app.workflow_run_active_admissions where workspace_id=$1',
          [fixture.workspaceId],
        ),
      ).toEqual([{ n: 0 }]);
    } finally {
      await workers.close();
      await resources.close();
      await limitWorkspace(5);
    }
  }, 40_000);

  it('gives each nested loop iteration its own callback identity and releases its slot while all four wait', async () => {
    const version = await publishGraph({
      settings: { maxRunDurationMs: 60_000 },
      nodes: [
        node('manual', 'core.manual'),
        loop('outer', loop('inner', wait('wait'))),
      ],
      edges: [edge('manual', 'outer')],
    });
    const run = await accept(version);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let tasks: readonly { id: string; callback_scope_hash: string }[] = [];
      await workers.until(async () => {
        tasks = await fixture.workerQuery(
          "select id,callback_scope_hash from app.pending_run_tasks where run_id=$1 and status='pending'",
          [run.runId],
        );
        expect(tasks).toHaveLength(4);
        expect(
          new Set(tasks.map((task) => task.callback_scope_hash)).size,
        ).toBe(4);
        expect(
          await fixture.workerQuery(
            'select status,human_wait_started_at is not null paused from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'waiting', paused: true }]);
      });
      await workers.restart();
      await Promise.all(tasks.map((task) => reply(resources, task.id)));
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
          'select count(*)::int n from app.pending_run_tasks where run_id=$1 and consumed_at is not null',
          [run.runId],
        ),
      ).toEqual([{ n: 4 }]);
    } finally {
      await workers.close();
      await resources.close();
    }
  }, 40_000);

  it('keeps independent parallel callbacks and releases capacity while both wait', async () => {
    const version = await publishGraph({
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
        wait('first'),
        wait('second'),
        {
          ...node('merge', 'core.merge'),
          config: { parallelNodeId: 'parallel', policy: { kind: 'all' } },
        },
      ],
      edges: [
        edge('manual', 'parallel'),
        edge('parallel', 'first', 'branch-01'),
        edge('parallel', 'second', 'branch-02'),
        {
          ...edge('first', 'merge'),
          target: { nodeId: 'merge', port: 'branch-01' },
        },
        {
          ...edge('second', 'merge'),
          target: { nodeId: 'merge', port: 'branch-02' },
        },
      ],
    });
    const run = await accept(version);
    const resources = callbackResources();
    const workers = await runtime(undefined, resources.capabilities);
    try {
      let tasks: readonly { id: string; callback_token_hash: string }[] = [];
      await workers.until(async () => {
        tasks = await fixture.workerQuery(
          "select id,callback_token_hash from app.pending_run_tasks where run_id=$1 and status='pending'",
          [run.runId],
        );
        expect(tasks).toHaveLength(2);
        expect(
          new Set(tasks.map((task) => task.callback_token_hash)).size,
        ).toBe(2);
        expect(
          await fixture.workerQuery(
            'select status,human_wait_started_at is not null paused from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'waiting', paused: true }]);
        expect(
          await fixture.workerQuery(
            'select active_runs+reserved_active_slots occupied from app.workflow_run_slot_counts($1,null,null)',
            [fixture.workspaceId],
          ),
        ).toEqual([{ occupied: 0 }]);
      });
      await workers.restart();
      await Promise.all(tasks.map((task) => reply(resources, task.id)));
      await workers.until(async () => {
        expect(
          await fixture.workerQuery(
            'select status from app.workflow_runs where id=$1',
            [run.runId],
          ),
        ).toEqual([{ status: 'succeeded' }]);
      });
    } finally {
      await workers.close();
      await resources.close();
    }
  }, 30_000);
}
