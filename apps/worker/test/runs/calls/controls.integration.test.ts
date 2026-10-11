import {
  createNodeRegistry,
  NodeExecutorFailure,
} from '@pertexo/node-sdk/server';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  CORE_NODE_DEFINITION_REGISTRATIONS,
  CORE_NODE_EXECUTOR_REGISTRATIONS,
} from '@pertexo/nodes-core/server';
import { createWorkflowRunDatabase } from '@pertexo/database/runs';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accept,
  childGraph,
  fixture,
  limitWorkspace,
  node,
  edge,
  parentGraph,
  publishGraph,
  runtime,
} from './fixtures.js';

const describeIntegration = fixture.enabled ? describe : describe.skip;
describeIntegration('Workflow Call controls and retained public reads', () => {
  beforeAll(fixture.setup, 60_000);
  afterAll(fixture.restoreServicesAndClose);
  const runs = createWorkflowRunDatabase(
    parseDatabaseConfig({
      connectionString: fixture.databaseUrl(fixture.apiUrl),
      max: 2,
    }),
  );
  afterAll(() => runs.close());

  async function activeChild(
    workers: Awaited<ReturnType<typeof runtime>>,
    parentRunId: string,
  ) {
    let childId = '';
    await workers.until(async () => {
      const rows = await fixture.workerQuery<{
        child_run_id: string;
        status: string;
      }>(
        'select call.child_run_id,child.status from app.workflow_calls call join app.workflow_runs child on child.id=call.child_run_id and child.workspace_id=call.workspace_id where call.parent_run_id=$1',
        [parentRunId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('waiting');
      childId = rows[0]?.child_run_id ?? '';
    });
    return childId;
  }
  async function settled(
    workers: Awaited<ReturnType<typeof runtime>>,
    runId: string,
    status: string,
  ) {
    await workers.until(async () => {
      expect(
        (await runs.get({ workspaceId: fixture.workspaceId, runId }))?.run
          .status,
      ).toBe(status);
    });
  }
  async function noLoans() {
    expect(
      await fixture.workerQuery(
        'select count(*)::int count from app.workflow_calls where workspace_id=$1 and slot_lent',
        [fixture.workspaceId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      await fixture.workerQuery(
        'select workflow_run_id from app.workflow_run_active_admissions where workspace_id=$1',
        [fixture.workspaceId],
      ),
    ).toEqual([]);
  }

  it('returns validated child output through ordinary run and step reads with a distinct origin and lineage', async () => {
    const child = await publishGraph(childGraph(1));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      const pending = await runs.get({
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
      });
      expect(pending?.calls).toMatchObject([
        {
          childRunId: childId,
          childHistory: 'retained',
          status: 'accepted',
          slotLent: true,
        },
      ]);
      const waitingCall = pending?.nodes.find((node) => node.nodeId === 'call');
      if (waitingCall === undefined) throw new Error('Call node missing');
      expect(
        await runs.readNodeRunOutput({
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          nodeRunId: waitingCall.id,
        }),
      ).toEqual({ kind: 'none' });
      const incoming = await runs.get({
        workspaceId: fixture.workspaceId,
        runId: childId,
      });
      expect(incoming?.run.triggerType).toBe('workflow_call');
      expect(incoming?.parentCall).toMatchObject({
        parentRunId: accepted.runId,
      });
      await settled(workers, accepted.runId, 'succeeded');
      expect(
        await runs.readNodeRunOutput({
          workspaceId: fixture.workspaceId,
          runId: accepted.runId,
          nodeRunId: waitingCall.id,
        }),
      ).toEqual({ kind: 'inline', value: 'Ada!' });
      const usage = await runs.statistics({
        workspaceId: fixture.workspaceId,
        window: '1h',
        includeWorkflows: true,
      });
      expect(
        usage.workflows?.items.find(
          (item) => item.workflowId === parent.workflowId,
        ),
      ).toMatchObject({ total: 1, byStatus: { succeeded: 1 } });
      expect(
        usage.workflows?.items.find(
          (item) => item.workflowId === child.workflowId,
        ),
      ).toMatchObject({ total: 1, byStatus: { succeeded: 1 } });
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('unwinds parent cancellation down a nested chain at capacity one and never resumes the terminal parent', async () => {
    await limitWorkspace(1);
    const leaf = await publishGraph(childGraph(60));
    const middle = await publishGraph(parentGraph(leaf.pin));
    const root = await publishGraph(parentGraph(middle.pin));
    const accepted = await accept(root);
    const workers = await runtime();
    try {
      const middleId = await activeChild(workers, accepted.runId);
      const leafId = await activeChild(workers, middleId);
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: accepted.runId,
      });
      await settled(workers, accepted.runId, 'canceled');
      await settled(workers, middleId, 'canceled');
      await settled(workers, leafId, 'canceled');
      await workers.restart();
      await workers.until(noLoans);
      expect(
        (
          await runs.get({
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.run.status,
      ).toBe('canceled');
    } finally {
      await workers.close();
      await limitWorkspace(5);
    }
  }, 30_000);

  it('fails a required Call when its child is canceled independently', async () => {
    const child = await publishGraph(childGraph(60));
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      await runs.cancel({
        workspaceId: fixture.workspaceId,
        actorId: fixture.actorId,
        runId: childId,
      });
      await settled(workers, childId, 'canceled');
      await settled(workers, accepted.runId, 'failed');
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('dispatches inherited deadline controls while the parent has lent its slot', async () => {
    const child = await publishGraph(childGraph(60));
    const parent = await publishGraph({
      ...parentGraph(child.pin),
      settings: { maxRunDurationMs: 2_000 },
    });
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      const deadlines = await fixture.workerQuery<{ deadline_at: Date }>(
        'select deadline_at from app.workflow_runs where id=any($1::uuid[])',
        [[accepted.runId, childId]],
      );
      expect(deadlines).toHaveLength(2);
      expect(deadlines[0]?.deadline_at).toEqual(deadlines[1]?.deadline_at);
      await settled(workers, accepted.runId, 'timed_out');
      // At the shared deadline, the child's own timeout and its parent's
      // close intent are ordinary competing controls; the first one settles it.
      await workers.until(async () => {
        expect(['timed_out', 'canceled']).toContain(
          (await runs.get({ workspaceId: fixture.workspaceId, runId: childId }))
            ?.run.status,
        );
      });
      await workers.until(noLoans);
    } finally {
      await workers.close();
    }
  }, 30_000);
  it('narrows the recorded child deadline and fails the required Call when the child times out first', async () => {
    const child = await publishGraph({
      ...childGraph(60),
      settings: { maxRunDurationMs: 2_000 },
    });
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      const childId = await activeChild(workers, accepted.runId);
      await settled(workers, childId, 'timed_out');
      await settled(workers, accepted.runId, 'failed');
      expect(
        (
          await runs.get({
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.calls,
      ).toMatchObject([{ status: 'timed_out', slotLent: false }]);
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('continues an accepted child after its workflow is archived and the starting member is revoked', async () => {
    const child = await publishGraph(childGraph(2));
    const parent = await publishGraph(parentGraph(child.pin));
    await fixture.ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner') on conflict do nothing",
      [fixture.workspaceId, fixture.actorId],
    );
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await activeChild(workers, accepted.runId);
      await fixture.ownerQuery(
        "update app.workflows set lifecycle_status='archived',lifecycle_revision=lifecycle_revision+1 where workspace_id=$1 and id=$2",
        [fixture.workspaceId, child.workflowId],
      );
      expect(
        await fixture.ownerQuery(
          'delete from app.workspace_memberships where workspace_id=$1 and user_id=$2 returning user_id',
          [fixture.workspaceId, fixture.actorId],
        ),
      ).toEqual([{ user_id: fixture.actorId }]);
      await workers.restart();
      await settled(workers, accepted.runId, 'succeeded');
      await noLoans();
    } finally {
      await workers.close();
      await fixture.ownerQuery(
        "insert into app.workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner') on conflict do nothing",
        [fixture.workspaceId, fixture.actorId],
      );
    }
  }, 30_000);

  it('fails the parent on an invalid child result rather than exposing its prepared Call input', async () => {
    const value = childGraph();
    if (value.callable === undefined) throw new Error('Child contract missing');
    const child = await publishGraph({
      ...value,
      callable: { ...value.callable, resultType: { type: 'number' } },
    });
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime();
    try {
      await settled(workers, accepted.runId, 'failed');
      expect(
        (
          await runs.get({
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.calls,
      ).toMatchObject([
        { status: 'failed', safeErrorCode: 'callable_result_invalid' },
      ]);
      await noLoans();
    } finally {
      await workers.close();
    }
  }, 30_000);

  it('keeps an unknown child outcome unknown through restart without rewriting the terminal parent', async () => {
    const registry = createNodeRegistry({
      catalog: CORE_NODE_CATALOG,
      definitions: CORE_NODE_DEFINITION_REGISTRATIONS,
      executors: CORE_NODE_EXECUTOR_REGISTRATIONS.map((registration) =>
        registration.executor.key !== 'core.set'
          ? registration
          : {
              ...registration,
              execute: () =>
                Promise.reject(
                  new NodeExecutorFailure({
                    kind: 'outcome_unknown',
                    errorKind: 'network',
                    possiblyDispatched: true,
                  }),
                ),
            },
      ),
    });
    const value = childGraph();
    const child = await publishGraph({
      ...value,
      nodes: [
        node('manual', 'core.manual'),
        node('uncertain', 'core.set'),
        node('finish', 'core.terminate'),
      ],
      edges: [edge('manual', 'uncertain'), edge('uncertain', 'finish')],
    });
    const parent = await publishGraph(parentGraph(child.pin));
    const accepted = await accept(parent);
    const workers = await runtime(registry);
    try {
      await settled(workers, accepted.runId, 'outcome_unknown');
      const saved = await runs.get({
        workspaceId: fixture.workspaceId,
        runId: accepted.runId,
      });
      expect(saved?.calls).toMatchObject([
        { status: 'outcome_unknown', slotLent: false },
      ]);
      await workers.restart();
      await workers.until(noLoans);
      expect(
        (
          await runs.get({
            workspaceId: fixture.workspaceId,
            runId: accepted.runId,
          })
        )?.run.status,
      ).toBe('outcome_unknown');
    } finally {
      await workers.close();
    }
  }, 30_000);
});
