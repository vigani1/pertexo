import { expect, it } from 'vitest';

import { WorkspaceRunAdmissionDeniedError } from '../../../src/runs/commands/acceptance/errors.js';

import { WorkflowRunNotFoundError } from '../../../src/runs/errors.js';

import {
  workspaceId,
  otherWorkspaceId,
  workflowVersionId,
  retainedWorkflowVersionId,
  otherWorkflowId,
  otherWorkflowVersionId,
  database,
  digest,
  startInput,
  replayInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerReplaysAgainstExplicitlySelectedRetained(): void {
  it('replays against an explicitly selected retained version without republishing it', async () => {
    const source = await database.start(
      startInput(
        digest('retained-source-request'),
        digest('retained-source-key'),
      ),
    );
    const replay = await database.replay(
      replayInput(source.run.id, digest('retained-replay-request'), {
        idempotencyKeyHash: digest('retained-replay-key'),
        selectedWorkflowVersionId: retainedWorkflowVersionId,
      }),
    );

    expect(replay.run).toMatchObject({
      workflowVersionId: retainedWorkflowVersionId,
      triggerType: 'replay',
      deadlineAt: new Date(replay.run.createdAt.getTime() + 5_000),
    });
    expect(source.run.deadlineAt).toBeNull();
    const duplicate = await database.replay(
      replayInput(source.run.id, digest('retained-replay-request'), {
        idempotencyKeyHash: digest('retained-replay-key'),
        selectedWorkflowVersionId: retainedWorkflowVersionId,
      }),
    );
    expect(duplicate.run.deadlineAt).toEqual(replay.run.deadlineAt);
    const state = await apiQuery(
      `select run.workflow_version_id,
              checkpoint.scheduler_state->>'workflowVersionId' checkpoint_version_id,
              workflow.published_version_id
         from app.workflow_runs run
         join app.run_checkpoints checkpoint
           on checkpoint.workspace_id=run.workspace_id
          and checkpoint.workflow_run_id=run.id
         join app.workflows workflow
           on workflow.workspace_id=run.workspace_id
          and workflow.id=run.workflow_id
        where run.id=$1`,
      [replay.run.id],
    );
    expect(state.rows).toEqual([
      {
        workflow_version_id: retainedWorkflowVersionId,
        checkpoint_version_id: retainedWorkflowVersionId,
        published_version_id: workflowVersionId,
      },
    ]);
  });

  it('rejects replay admission and rolls back the acceptance claim', async () => {
    const source = await database.start(
      startInput(
        digest('admission-source-request'),
        digest('admission-source-key'),
      ),
    );
    await ownerQuery(
      `insert into app.workspace_execution_entitlement_versions
         (workspace_id,version,status,active_run_limit,queued_run_limit,effective_at)
       values ($1,2,'suspended',5,100,'-infinity'::timestamptz)`,
      [workspaceId],
    );
    await ownerQuery(
      `update app.workspace_execution_entitlements
          set current_version=2
        where workspace_id=$1`,
      [workspaceId],
    );

    await expect(
      database.replay(
        replayInput(source.run.id, digest('admission-replay-request'), {
          idempotencyKeyHash: digest('admission-replay-key'),
        }),
      ),
    ).rejects.toBeInstanceOf(WorkspaceRunAdmissionDeniedError);
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });

  it('hides cross-tenant replay sources and versions without side effects', async () => {
    const otherSource = await database.start(
      startInput(digest('other-source-request'), digest('other-source-key'), {
        workspaceId: otherWorkspaceId,
        workflowId: otherWorkflowId,
        workflowVersionId: otherWorkflowVersionId,
      }),
    );
    await expect(
      database.replay(
        replayInput(otherSource.run.id, digest('cross-source-request'), {
          idempotencyKeyHash: digest('cross-source-key'),
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    const source = await database.start(
      startInput(digest('cross-version-source'), digest('cross-version-key')),
    );
    await expect(
      database.replay(
        replayInput(source.run.id, digest('cross-version-request'), {
          idempotencyKeyHash: digest('cross-version-replay-key'),
          selectedWorkflowVersionId: otherWorkflowVersionId,
        }),
      ),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });

  it('rolls back a replay acceptance when a downstream run constraint fails', async () => {
    const source = await database.start(
      startInput(
        digest('rollback-source-request'),
        digest('rollback-source-key'),
      ),
    );

    await expect(
      database.replay(
        replayInput(source.run.id, digest('rollback-replay-request'), {
          idempotencyKeyHash: digest('rollback-replay-key'),
          selectedWorkflowVersionId: workflowVersionId,
          deadlineAt: new Date(0),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits,
         (select count(*)::int from app.idempotency_records) idempotency`,
    );
    expect(effects.rows).toEqual([
      {
        runs: 1,
        checkpoints: 1,
        events: 1,
        outbox: 1,
        audits: 1,
        idempotency: 1,
      },
    ]);
  });
}
