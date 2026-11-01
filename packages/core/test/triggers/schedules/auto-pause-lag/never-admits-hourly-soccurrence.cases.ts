import { actorId, workspaceId, workflowId, ownerQuery } from './fixture.js';
import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import {
  fixture,
  triggerId,
  observer,
  scope,
  pausedAt,
  pausedIn,
  controls,
  pause,
  resume,
  configure,
  scan,
  runs,
  latestPeriod,
  claim,
  release,
  waitBlocked,
} from './fixture.js';

export function registerNeverAdmitsHourlySOccurrence(): void {
  it.each(['catch_up_once', 'skip'] as const)(
    'never admits an hourly %s occurrence that fell due during a completed pause',
    async (policy) => {
      const id = randomUUID();
      const due = await configure(id, undefined, true, policy);
      const before = await runs();
      await resume(await pause());
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'none',
      );
      expect(await scan()).toMatchObject({
        claimed: 1,
        accepted: 0,
        paused: 1,
        skipped: 0,
      });
      expect(await runs()).toBe(before);
      expect(
        (
          await ownerQuery(
            `select disposition,workflow_run_id from app.trigger_schedule_occurrences
      where workspace_id=$1 and trigger_id=$2 and scheduled_at=$3::timestamptz`,
            [workspaceId, id, due],
          )
        ).rows,
      ).toEqual([{ disposition: 'paused', workflow_run_id: null }]);
      expect(
        (
          await ownerQuery<{ advanced: boolean }>(
            'select next_fire_at>clock_timestamp() advanced from app.trigger_schedules where trigger_id=$1',
            [id],
          )
        ).rows[0]?.advanced,
      ).toBe(true);

      // The next actual due instant outside the closed pause is accepted under
      // either policy. Millisecond rounding stays safely after the SQL cut.
      const future = (
        await ownerQuery<{ due: string }>(
          `select to_char((resumed_at+interval '1 millisecond') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') due from app.workflow_trigger_pause_periods
      where workspace_id=$1 and workflow_id=$2 order by pause_revision desc limit 1`,
          [workspaceId, workflowId],
        )
      ).rows[0]?.due;
      if (future === undefined) throw new Error('Missing post-resume instant');
      // A fresh future-anchored schedule demonstrates admission outside the
      // pause without changing an existing immutable recurrence or clock.
      await configure(randomUUID(), future, true, policy);
      expect(await scan()).toMatchObject({
        claimed: 1,
        accepted: 1,
        paused: 0,
      });
      expect(await runs()).toBe((before ?? 0) + 1);
    },
  );

  it('keeps older completed pause intervals through repeated cycles, replay, no-op, and disabled schedule lag', async () => {
    const due = await configure(triggerId, undefined, false);
    const revision = await pause();
    const key = randomUUID();
    const accepted = await resume(revision, key);
    const first = await latestPeriod();
    await resume(accepted.settings.pauseRevision);
    expect(await resume(revision, key)).toEqual({
      ...accepted,
      replayed: true,
    });
    expect(
      (
        await ownerQuery(
          'select 1 from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2 and pause_revision=$3::bigint',
          [workspaceId, workflowId, first.revision],
        )
      ).rows,
    ).toHaveLength(1);
    expect(await scan()).toMatchObject({ claimed: 0, accepted: 0, paused: 0 });
    const secondStart = (
      await ownerQuery<{ instant: string }>(
        'select to_char(clock_timestamp() at time zone \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') instant',
      )
    ).rows[0]?.instant;
    if (secondStart === undefined)
      throw new Error('Missing second pause start');
    await resume(await pause(secondStart));
    const second = await latestPeriod();
    expect(second.revision).not.toBe(first.revision);
    await configure(triggerId, due);
    const before = await runs();
    expect(await scan()).toMatchObject({ accepted: 0, paused: 1 });
    expect(await runs()).toBe(before);
  });

  it('uses exact pause boundaries: the start is paused and the resume instant is outside', async () => {
    await configure(randomUUID());
    await resume(await pause());
    // Scheduled instants are milliseconds; align the period to them.
    await ownerQuery(
      `update app.workflow_trigger_pause_periods
       set paused_at=date_trunc('milliseconds',paused_at),
           resumed_at=date_trunc('milliseconds',resumed_at)
       where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, workflowId],
    );
    const period = await latestPeriod();
    const beforeFirst = (
      await ownerQuery<{ instant: string }>(
        `select to_char((min(paused_at)-interval '1 millisecond') at time zone 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') instant
          from app.workflow_trigger_pause_periods where workspace_id=$1 and workflow_id=$2`,
        [workspaceId, workflowId],
      )
    ).rows[0]?.instant;
    if (beforeFirst === undefined) throw new Error('Missing pre-pause instant');
    const lease = await claim();
    try {
      for (const [instant, expected] of [
        [beforeFirst, false],
        [period.paused, true],
        [period.resumed, false],
      ] as const)
        expect(await pausedAt(lease, instant)).toBe(expected);
    } finally {
      await release(lease);
    }
  });

  it('keeps a paused admission decision valid while a resume waits on its workflow share lock', async () => {
    const due = await configure(randomUUID());
    const revision = await pause();
    const lease = await claim();
    const admission = await fixture.worker.connect();
    let pending: ReturnType<typeof resume> | undefined;
    try {
      await admission.query('begin');
      const pid = (
        await admission.query<{ pid: number }>('select pg_backend_pid() pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing admission pid');
      expect(await pausedIn(admission, lease, due)).toBe(true);
      pending = resume(revision);
      await waitBlocked(pid);
      await admission.query('commit');
      expect((await pending).settings.pauseState).toBe('none');
      await admission.query('begin');
      expect(await pausedIn(admission, lease, due)).toBe(true);
      await admission.query('commit');
    } finally {
      await admission.query('rollback');
      admission.release();
      await pending;
      await release(lease);
    }
  });

  it('sees the committed interval after admission waits on an in-progress resume', async () => {
    const due = await configure(randomUUID());
    const revision = await pause();
    const lease = await claim();
    const resuming = await observer.connect();
    let pending: Promise<boolean> | undefined;
    try {
      await resuming.query('begin');
      await resuming.query('set local role pertexo_app');
      await resuming.query(
        "select set_config('app.workspace_id',$1,true),set_config('app.actor_id',$2,true)",
        [workspaceId, actorId],
      );
      const pid = (
        await resuming.query<{ pid: number }>('select pg_backend_pid() pid')
      ).rows[0]?.pid;
      if (pid === undefined) throw new Error('Missing resuming pid');
      // Make the resume's writes as the app role but hold the commit, so the
      // admission's workflow SHARE lock has to wait for the cleared state.
      await resuming.query(
        `insert into app.workflow_trigger_pause_periods
           (workspace_id, workflow_id, pause_revision, paused_at, resumed_at)
         select workspace_id, id, trigger_pause_revision, trigger_paused_at, clock_timestamp()
         from app.workflows
         where workspace_id = $1 and id = $2 and trigger_pause_revision = $3::bigint`,
        [workspaceId, workflowId, revision],
      );
      await resuming.query(
        `update app.workflows
         set trigger_pause_state = 'none', trigger_paused_at = null,
             trigger_pause_reason = null, trigger_pause_failures = null,
             trigger_pause_last_run_id = null,
             trigger_pause_revision = trigger_pause_revision + 1
         where workspace_id = $1 and id = $2`,
        [workspaceId, workflowId],
      );
      pending = pausedAt(lease, due);
      await waitBlocked(pid);
      await resuming.query('commit');
      expect(await pending).toBe(true);
      expect((await controls().readWorkflowSettings(scope)).pauseState).toBe(
        'none',
      );
    } finally {
      await resuming.query('rollback');
      resuming.release();
      await pending;
      await release(lease);
    }
  });
}
