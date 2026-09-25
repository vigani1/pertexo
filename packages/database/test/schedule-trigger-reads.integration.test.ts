import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ScheduleTriggerError } from '../src/triggers/schedule-trigger-errors.js';
import type { ScheduleOccurrencePosition } from '../src/triggers/schedule-trigger-reads.js';
import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

const schedule = createScheduleTriggerTestEnvironment();
const {
  actorId,
  checkpointFactory,
  ownerQuery,
  skipTriggerId,
  triggerId,
  versionId,
  workflowId,
  workspaceId,
} = schedule;
const viewerId = randomUUID();
const cronTriggerId = randomUUID();
const read = { workspaceId, actorId, workflowId, triggerId };

async function expectHidden(work: Promise<unknown>): Promise<void> {
  await expect(work).rejects.toBeInstanceOf(ScheduleTriggerError);
  await expect(work).rejects.toMatchObject({ code: 'not_found' });
}

/** Rows a read must never change: schedule state, facts and command claims. */
async function writeFingerprint(): Promise<string> {
  const result = await ownerQuery<{ fingerprint: string }>(
    `select md5(concat_ws('|',
       (select string_agg(concat_ws(',',trigger_id,next_fire_at,last_fire_at,
          status,health_status,updated_at,lease_token),';' order by trigger_id)
          from app.trigger_schedules),
       (select count(*) from app.trigger_schedule_occurrences),
       (select count(*) from app.workflow_runs),
       (select count(*) from app.audit_events),
       (select count(*) from app.idempotency_records))) fingerprint`,
  );
  return result.rows[0]?.fingerprint ?? '';
}

beforeAll(async () => {
  await schedule.initialize();
  // One scan admits the catch-up occurrence, the next records the skip.
  for (const leaseOwner of ['reads-scanner-one', 'reads-scanner-two'])
    await schedule.scannerOne.scanDue({
      leaseOwner,
      limit: 1,
      leaseSeconds: 30,
      checkpointFactory,
    });
  await schedule.identity.createUser({
    id: viewerId,
    email: `schedule-viewer-${viewerId}@example.test`,
    displayName: 'Schedule Viewer',
  });
  await ownerQuery(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status)
     values($1,$2,'viewer','active')`,
    [workspaceId, viewerId],
  );
  const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(cronTriggerId).digest('hex')}`;
  await ownerQuery(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
       node_id,kind,status,desired_config,config_fingerprint,health_status)
     values($1,$2,$3,$4,'schedule-cron','schedule','active',$5::jsonb,$6,'healthy')`,
    [
      cronTriggerId,
      workspaceId,
      workflowId,
      versionId,
      JSON.stringify({
        kind: 'cron',
        expression: '30 2 * * *',
        timezone: 'America/New_York',
      }),
      fingerprint,
    ],
  );
  // 02:30 does not exist on 10 March 2030 in New York: the persisted next
  // fire is the first valid instant after the gap (ADR 014).
  await ownerQuery(
    `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
       cron_expression,timezone,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
     values($1,$2,'cron','30 2 * * *','America/New_York','catch_up_once',$3,
       '2030-03-09T12:00:00Z','2030-03-10T07:00:00Z')`,
    [cronTriggerId, workspaceId, fingerprint],
  );
}, 60_000);
afterAll(schedule.close);

describe('schedule occurrence history', () => {
  it('serves the scanner’s own outcomes with the run each admitted', async () => {
    const admitted = await schedule.schedules.listOccurrences(read);
    expect(admitted.nextCursor).toBeUndefined();
    const microsecondInstant = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u;
    expect(admitted.items).toHaveLength(1);
    expect(admitted.items[0]?.outcome).toBe('accepted');
    expect(admitted.items[0]?.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(admitted.items[0]?.scheduledAt).toMatch(microsecondInstant);
    expect(admitted.items[0]?.recordedAt).toMatch(microsecondInstant);
    const run = await ownerQuery<{ trigger_type: string }>(
      'select trigger_type from app.workflow_runs where id=$1',
      [admitted.items[0]?.runId],
    );
    expect(run.rows).toEqual([{ trigger_type: 'schedule' }]);
    const recordedAt = Date.parse(admitted.items[0]?.recordedAt ?? '');
    const scheduledAt = Date.parse(admitted.items[0]?.scheduledAt ?? '');
    expect(recordedAt).toBeGreaterThanOrEqual(scheduledAt);

    // Every active member reads schedule history, as with trigger health.
    const skipped = await schedule.schedules.listOccurrences({
      ...read,
      actorId: viewerId,
      triggerId: skipTriggerId,
    });
    expect(skipped.items).toEqual([
      expect.objectContaining({ outcome: 'skipped', runId: null }),
    ]);
  });

  it('pages newest first by a stable keyset and hides expired rows', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    const recent = await ownerQuery<{ scheduled_at: string }>(
      `select to_char(max(scheduled_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
         scheduled_at from app.trigger_schedule_occurrences where trigger_id=$1`,
      [skipTriggerId],
    );
    const newest = Date.parse(recent.rows[0]?.scheduled_at ?? '');
    expect(newest).toBeGreaterThan(base);
    for (const offsetMinutes of [-10, -20, -30])
      await ownerQuery(
        `insert into app.trigger_schedule_occurrences
           (id,workspace_id,trigger_id,scheduled_at,disposition)
         values($1,$2,$3,$4::timestamptz,'skipped')`,
        [
          randomUUID(),
          workspaceId,
          skipTriggerId,
          new Date(newest + offsetMinutes * 60_000).toISOString(),
        ],
      );
    // Past ADR 013's 90-day trigger-summary cutoff: retained until the reaper
    // runs, but never served.
    await ownerQuery(
      `insert into app.trigger_schedule_occurrences
         (id,workspace_id,trigger_id,scheduled_at,disposition)
       values($1,$2,$3,clock_timestamp()-interval '91 days','skipped')`,
      [randomUUID(), workspaceId, skipTriggerId],
    );

    const skipRead = { ...read, triggerId: skipTriggerId, limit: 2 };
    const pages: string[][] = [];
    let after: ScheduleOccurrencePosition | undefined;
    do {
      const page = await schedule.schedules.listOccurrences({
        ...skipRead,
        ...(after === undefined ? {} : { after }),
      });
      pages.push(page.items.map(({ scheduledAt }) => scheduledAt));
      after = page.nextCursor;
    } while (after !== undefined);
    const served = pages.flat();
    expect(pages.map((page) => page.length)).toEqual([2, 2]);
    expect(served).toHaveLength(4);
    expect([...served].sort().reverse()).toEqual(served);
    expect(new Set(served).size).toBe(4);
    await expect(
      schedule.schedules.listOccurrences({ ...skipRead, limit: 100 }),
    ).resolves.toMatchObject({ items: { length: 4 } });
  });

  it('never discloses another workflow’s, kind’s or tenant’s schedule', async () => {
    const webhookTriggerId = randomUUID();
    await ownerQuery(
      `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
         node_id,kind,status,desired_config,config_fingerprint,health_status)
       values($1,$2,$3,$4,'hook','webhook','configuration_required','{}'::jsonb,$5,'pending')`,
      [
        webhookTriggerId,
        workspaceId,
        workflowId,
        versionId,
        `trigger:v1:sha256:${'b'.repeat(64)}`,
      ],
    );
    for (const hidden of [
      { ...read, actorId: randomUUID() },
      { ...read, workflowId: randomUUID() },
      { ...read, workspaceId: randomUUID() },
      { ...read, triggerId: webhookTriggerId },
      { ...read, triggerId: randomUUID() },
    ]) {
      await expectHidden(schedule.schedules.listOccurrences(hidden));
      await expectHidden(
        schedule.schedules.nextFireTimes({ ...hidden, count: 3 }),
      );
    }
    await expectHidden(
      schedule.schedules.previewFireTimes({
        workspaceId,
        actorId: randomUUID(),
        workflowId,
        recurrence: { kind: 'interval', intervalMinutes: 5 },
        count: 1,
      }),
    );
    // The API role sees occurrences only inside their own workspace scope.
    const api = new Pool({
      connectionString: schedule.apiConnectionString,
      max: 1,
    });
    try {
      const visible = async (scope: string) => {
        const client = await api.connect();
        try {
          await client.query('begin');
          await client.query("select set_config('app.workspace_id',$1,true)", [
            scope,
          ]);
          const result = await client.query(
            'select id from app.trigger_schedule_occurrences where trigger_id=$1',
            [triggerId],
          );
          await client.query('rollback');
          return result.rowCount;
        } finally {
          client.release();
        }
      };
      await expect(visible(randomUUID())).resolves.toBe(0);
      await expect(visible(workspaceId)).resolves.toBe(1);
    } finally {
      await api.end();
    }
  });
});

describe('schedule fire times', () => {
  it('starts from the persisted next fire and follows the scanner after it', async () => {
    const state = await ownerQuery<{ next_fire_at: Date }>(
      'select next_fire_at from app.trigger_schedules where trigger_id=$1',
      [triggerId],
    );
    const nextFireAt = state.rows[0]?.next_fire_at.getTime() ?? Number.NaN;
    const before = await writeFingerprint();

    const times = await schedule.schedules.nextFireTimes({ ...read, count: 3 });

    expect(times.items.map((instant) => instant.getTime())).toEqual([
      nextFireAt,
      nextFireAt + 60_000,
      nextFireAt + 120_000,
    ]);
    expect(times.observedAt.getTime()).toBeLessThan(nextFireAt);
    await expect(writeFingerprint()).resolves.toBe(before);
  });

  it('projects a persisted cron schedule through its timezone’s DST rules', async () => {
    const times = await schedule.schedules.nextFireTimes({
      ...read,
      actorId: viewerId,
      triggerId: cronTriggerId,
      count: 3,
    });
    expect(times.items.map((instant) => instant.toISOString())).toEqual([
      '2030-03-10T07:00:00.000Z',
      '2030-03-11T06:30:00.000Z',
      '2030-03-12T06:30:00.000Z',
    ]);
  });

  it('has nothing upcoming while the schedule is off', async () => {
    const setEnabled = (enabled: boolean) =>
      schedule.schedules.setEnabled({
        ...read,
        triggerId: cronTriggerId,
        enabled,
        idempotencyKey: `reads-${String(enabled)}`,
        requestHash: createHash('sha256')
          .update(`reads-${String(enabled)}`)
          .digest('hex'),
      });
    await setEnabled(false);
    await expect(
      schedule.schedules.nextFireTimes({
        ...read,
        triggerId: cronTriggerId,
        count: 3,
      }),
    ).resolves.toMatchObject({ items: [] });
    await setEnabled(true);
    await expect(
      schedule.schedules.nextFireTimes({
        ...read,
        triggerId: cronTriggerId,
        count: 1,
      }),
    ).resolves.toMatchObject({ items: [new Date('2030-03-10T07:00:00Z')] });
  });

  it('previews an unsaved rule from database time without writing', async () => {
    const before = await writeFingerprint();

    const interval = await schedule.schedules.previewFireTimes({
      workspaceId,
      actorId: viewerId,
      workflowId,
      recurrence: { kind: 'interval', intervalMinutes: 15 },
      count: 3,
    });
    const observed = interval.observedAt.getTime();
    expect(interval.items.map((instant) => instant.getTime())).toEqual([
      observed + 15 * 60_000,
      observed + 30 * 60_000,
      observed + 45 * 60_000,
    ]);
    expect(Math.abs(observed - Date.now())).toBeLessThan(60_000);

    const cron = await schedule.schedules.previewFireTimes({
      workspaceId,
      actorId,
      workflowId,
      recurrence: {
        kind: 'cron',
        expression: '0 9 * * 1-5',
        timezone: 'Europe/Paris',
      },
      count: 10,
    });
    expect(cron.items).toHaveLength(10);
    for (const instant of cron.items) {
      expect(instant.getTime()).toBeGreaterThan(cron.observedAt.getTime());
      expect(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Paris',
          hour: '2-digit',
          minute: '2-digit',
          weekday: 'short',
        }).format(instant),
      ).toMatch(/^(Mon|Tue|Wed|Thu|Fri) 09:00$/u);
    }
    await expect(writeFingerprint()).resolves.toBe(before);
  });

  it.each([
    { kind: 'cron', expression: '0 25 * * *', timezone: 'Europe/Paris' },
    { kind: 'cron', expression: '0 9 * * *', timezone: 'Etc/GMT+2' },
    { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
    { kind: 'cron', expression: '0 9 * * *', timezone: 'US/Eastern' },
    {
      kind: 'interval',
      intervalMinutes: 15,
      misfirePolicy: 'catch_up_once',
    },
    { kind: 'interval', intervalMinutes: 43_201 },
  ])('rejects a rule the scheduler would reject: %j', async (recurrence) => {
    await expect(
      schedule.schedules.previewFireTimes({
        workspaceId,
        actorId,
        workflowId,
        recurrence,
        count: 3,
      }),
    ).rejects.toMatchObject({ code: 'invalid_recurrence' });
  });
});
