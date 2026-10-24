import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { IdempotencyRequestConflictError } from '../../../src/runs/commands/acceptance/errors.js';

import {
  WorkflowRunNotFoundError,
  WorkflowRunNotExecutableError,
} from '../../../src/runs/errors.js';
import type { ExecutionStateConflictError } from '../../../src/runs/state-errors.js';

import {
  workspaceId,
  actorId,
  workflowId,
  workflowVersionId,
  database,
  digest,
  startInput,
  replayInput,
  ownerQuery,
  apiQuery,
} from './fixture.js';

export function registerDistinguishesExactConflictingAbsentReason(): void {
  it('distinguishes exact, conflicting, absent-reason, and terminal cancellation', async () => {
    const started = await database.start(startInput());
    const first = await database.cancel({
      actorId,
      workspaceId,
      runId: started.run.id,
    });
    expect(first).toMatchObject({ alreadyRequested: false, eventSequence: 2 });

    const otherDecider = randomUUID();
    await ownerQuery(
      "insert into app.users(id,email,display_name) values($1,$2,'Other canceller')",
      [otherDecider, `${otherDecider}@example.test`],
    );
    await ownerQuery(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'operator','active')",
      [workspaceId, otherDecider],
    );
    await expect(
      database.cancel({
        actorId: otherDecider,
        workspaceId,
        runId: started.run.id,
      }),
    ).rejects.toMatchObject({ message: 'execution.cancel_request_conflict' });
    await expect(
      database.cancel({
        actorId: randomUUID(),
        workspaceId,
        runId: started.run.id,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);
    await expect(
      database.cancel({
        actorId,
        workspaceId,
        runId: started.run.id,
        reason: 'different reason',
      }),
    ).rejects.toMatchObject({ message: 'execution.cancel_request_conflict' });

    await ownerQuery(
      `update app.workflow_runs
          set status='succeeded',started_at=clock_timestamp(),
              completed_at=clock_timestamp()
        where id=$1`,
      [started.run.id],
    );
    await expect(
      database.cancel({ actorId, workspaceId, runId: started.run.id }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ExecutionStateConflictError>>({
        message: 'execution.run_terminal',
      }),
    );
    const effects = await apiQuery(
      `select
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([{ events: 2, outbox: 2, audits: 2 }]);
  });

  it('rejects a new start when the workflow has no executable publication', async () => {
    await ownerQuery(
      `update app.workflows set published_version_id = null where id = $1`,
      [workflowId],
    );
    await expect(database.start(startInput())).rejects.toBeInstanceOf(
      WorkflowRunNotExecutableError,
    );
  });

  it('atomically accepts an explicit replay while preserving the source run', async () => {
    const source = await database.start(startInput());
    const replay = await database.replay(replayInput(source.run.id));

    expect(replay.replayed).toBe(false);
    expect(replay.run.id).not.toBe(source.run.id);
    expect(replay.run).toMatchObject({
      workflowId,
      workflowVersionId,
      status: 'queued',
      triggerType: 'replay',
    });
    await expect(
      database.get({ actorId: actorId, workspaceId, runId: source.run.id }),
    ).resolves.toMatchObject({
      run: {
        id: source.run.id,
        triggerType: 'manual',
        workflowVersionId,
      },
      nodes: [],
    });

    const lineage = await apiQuery<{
      replay_source_run_id: string;
      replay_command_id: string;
      trigger_type: string;
    }>(
      `select replay_source_run_id,replay_command_id,trigger_type
       from app.workflow_runs where id=$1`,
      [replay.run.id],
    );
    expect(lineage.rows).toHaveLength(1);
    const lineageRow = lineage.rows[0];
    if (lineageRow === undefined) throw new Error('Replay lineage is missing');
    expect(lineageRow.replay_source_run_id).toBe(source.run.id);
    expect(lineageRow.trigger_type).toBe('replay');
    expect(lineageRow.replay_command_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );

    await expect(database.replay(replayInput(source.run.id))).resolves.toEqual({
      ...replay,
      replayed: true,
    });
    await expect(
      database.replay(replayInput(source.run.id, digest('replay-request-2'))),
    ).rejects.toBeInstanceOf(IdempotencyRequestConflictError);

    const effects = await apiQuery(
      `select
         (select count(*)::int from app.workflow_runs) runs,
         (select count(*)::int from app.run_checkpoints) checkpoints,
         (select count(*)::int from app.run_events) events,
         (select count(*)::int from app.outbox_events) outbox,
         (select count(*)::int from app.audit_events) audits`,
    );
    expect(effects.rows).toEqual([
      { runs: 2, checkpoints: 2, events: 2, outbox: 2, audits: 2 },
    ]);
  });

  it('serializes concurrent exact replay requests to one durable run', async () => {
    const source = await database.start(
      startInput(digest('race-source-request'), digest('race-source-key')),
    );
    const outcomes = await Promise.all([
      database.replay(
        replayInput(source.run.id, digest('race-replay-request'), {
          idempotencyKeyHash: digest('race-replay-key'),
        }),
      ),
      database.replay(
        replayInput(source.run.id, digest('race-replay-request'), {
          idempotencyKeyHash: digest('race-replay-key'),
        }),
      ),
    ]);

    expect(outcomes.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(outcomes[0].run.id).toBe(outcomes[1].run.id);
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
        runs: 2,
        checkpoints: 2,
        events: 2,
        outbox: 2,
        audits: 2,
        idempotency: 2,
      },
    ]);
  });
}
