import { WORKFLOW_GRAPH_LIMITS } from '@pertexo/workflow-model';

import { expect, it, vi } from 'vitest';

import { IdempotencyRequestConflictError } from '../../../src/runs/commands/acceptance/errors.js';

import {
  WorkflowRunReadCapacityError,
  WorkflowPublishedVersionConflictError,
} from '../../../src/runs/errors.js';

import {
  workspaceId,
  otherWorkspaceId,
  actorId,
  workflowId,
  workflowVersionId,
  retainedWorkflowVersionId,
  owner,
  database,
  digest,
  startInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerReportsVersionConflictPublicationCommits(): void {
  it('reports a version conflict when publication commits while the command waits for its lock', async () => {
    const publishing = await owner.connect();
    let attempted: ReturnType<typeof database.start> | undefined;
    try {
      await publishing.query('begin');
      await publishing.query('set local role pertexo_owner');
      await publishing.query("select set_config('app.workspace_id',$1,true)", [
        workspaceId,
      ]);
      await publishing.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [workflowId, retainedWorkflowVersionId],
      );
      attempted = database.start({
        ...startInput(),
        expectedPublishedVersionId: workflowVersionId,
      });
      const rejected = expect(attempted).rejects.toBeInstanceOf(
        WorkflowPublishedVersionConflictError,
      );
      await vi.waitFor(
        async () => {
          const waiting = await apiQuery(
            "select count(*)::int count from pg_stat_activity where usename='pertexo_app' and wait_event_type='Lock'",
          );
          expect(waiting.rows[0]?.count).toBeGreaterThanOrEqual(1);
        },
        { timeout: 3000 },
      );
      await publishing.query('commit');
      await rejected;
    } finally {
      await publishing.query('rollback').catch(() => undefined);
      if (attempted !== undefined) await attempted.catch(() => undefined);
      publishing.release();
    }
    expect(
      (await apiQuery('select count(*)::int count from app.workflow_runs'))
        .rows,
    ).toEqual([{ count: 0 }]);
  });

  it('atomically starts, exactly replays, reads, and cancels one published run', async () => {
    const first = await database.start(startInput());
    expect(first.replayed).toBe(false);
    expect(first.run).toMatchObject({
      workflowId,
      workflowVersionId,
      status: 'queued',
    });

    await ownerQuery(
      `update app.workflows set published_version_id = null where id = $1`,
      [workflowId],
    );
    const replay = await database.start(startInput());
    expect(replay).toEqual({ ...first, replayed: true });
    await expect(
      database.start(startInput(digest('different-request'))),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);

    await expect(
      database.get({
        actorId: actorId,
        workspaceId: otherWorkspaceId,
        runId: first.run.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      database.get({ actorId: actorId, workspaceId, runId: first.run.id }),
    ).resolves.toMatchObject({ run: { id: first.run.id }, nodes: [] });

    const canceled = await database.cancel({
      actorId,
      workspaceId,
      runId: first.run.id,
      reason: 'operator request',
      requestId: 'request-cancel-42',
    });
    expect(canceled.alreadyRequested).toBe(false);
    expect(canceled.run.cancelRequestedAt).toBeInstanceOf(Date);
    await expect(
      database.cancel({
        actorId,
        workspaceId,
        runId: first.run.id,
        reason: 'operator request',
        requestId: 'request-cancel-42',
      }),
    ).resolves.toMatchObject({ alreadyRequested: true });

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([
      { runs: 1, checkpoints: 1, events: 2, outbox: 2, audits: 2 },
    ]);
  });

  it('maps a nonempty node snapshot and enforces the exact read-capacity boundary', async () => {
    const started = await database.start(startInput());
    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class)
       select gen_random_uuid(),$1,$2,'node-'||ordinal,'node-'||ordinal,
              '{}'::jsonb,'pending','safe'
       from generate_series(1,$3::int) ordinal`,
      [
        workspaceId,
        started.run.id,
        WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
      ],
    );
    const exact = await database.get({
      actorId: actorId,
      workspaceId,
      runId: started.run.id,
    });
    expect(exact?.nodes).toHaveLength(
      WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
    );
    expect(
      exact?.nodes.find((node) => node.invocationKey === 'node-1'),
    ).toMatchObject({
      currentAttemptNumber: 0,
      invocationKey: 'node-1',
      status: 'pending',
    });

    await ownerQuery(
      `insert into app.node_runs
         (id,workspace_id,workflow_run_id,node_id,invocation_key,
          branch_context,status,side_effect_class)
       values(gen_random_uuid(),$1,$2,'overflow','overflow','{}','pending','safe')`,
      [workspaceId, started.run.id],
    );
    await expect(
      database.get({ actorId: actorId, workspaceId, runId: started.run.id }),
    ).rejects.toBeInstanceOf(WorkflowRunReadCapacityError);
  });

  it('reads a full Call history and rejects an overflowing history', async () => {
    const started = await database.start(startInput());
    const insert = (count: number, offset = 0) =>
      ownerQuery(
        `insert into app.workflow_calls
        (id,workspace_id,parent_run_id,invocation_key,target_workflow_id,
         target_version_id,target_checksum,input_checksum,status)
       select gen_random_uuid(),$1,$2,'call-'||(ordinal+$6::int),$3,$4,
         'sha256:'||repeat('a',64),repeat('b',64),'pending'
       from generate_series(1,$5::int) ordinal`,
        [
          workspaceId,
          started.run.id,
          workflowId,
          workflowVersionId,
          count,
          offset,
        ],
      );
    await insert(WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations);
    const exact = await database.get({
      actorId: actorId,
      workspaceId,
      runId: started.run.id,
    });
    expect(exact?.calls).toHaveLength(
      WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations,
    );
    expect(
      exact?.calls?.find((call) => call.invocationKey === 'call-2499'),
    ).toMatchObject({
      status: 'pending',
      childHistory: 'not_started',
      childRunId: null,
    });
    await insert(1, WORKFLOW_GRAPH_LIMITS.maxExpandedInvocations);
    await expect(
      database.get({ actorId: actorId, workspaceId, runId: started.run.id }),
    ).rejects.toBeInstanceOf(WorkflowRunReadCapacityError);
  });
}
