import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScheduleTriggerTestEnvironment } from './support/schedule-triggers.integration.support.js';

/**
 * ADR 049 against PostgreSQL time: a `skip` schedule admits its greatest due
 * occurrence when the scanner observes it within the on-time window, records
 * it skipped when later, and `catch_up_once` is unchanged. Exact boundaries
 * and DST instants need a controlled clock and are unit-tested in
 * `schedule-trigger-scanner.test.ts`.
 */
const schedule = createScheduleTriggerTestEnvironment();
const { checkpointFactory, ownerQuery, versionId, workflowId, workspaceId } =
  schedule;

// A canonical zone at UTC+0 all year; `UTC` itself is an alias (ADR 014).
const timezone = 'Atlantic/Reykjavik';

type Policy = 'catch_up_once' | 'skip';
type Recurrence =
  | Readonly<{ kind: 'interval'; minutes: number }>
  | Readonly<{ kind: 'cron'; expression: string }>;

/**
 * One enabled schedule anchored `anchorSecondsAgo` before database time. The
 * claim function admits one due schedule per workspace per call, so each
 * scenario disables its schedule once it has been scanned.
 */
async function insertSchedule(
  policy: Policy,
  recurrence: Recurrence,
  anchorSecondsAgo: number,
): Promise<string> {
  const id = randomUUID();
  const fingerprint = `trigger:v1:sha256:${createHash('sha256').update(id).digest('hex')}`;
  const config =
    recurrence.kind === 'interval'
      ? { kind: 'interval', intervalMinutes: recurrence.minutes }
      : { kind: 'cron', expression: recurrence.expression, timezone };
  await ownerQuery(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
       node_id,kind,status,desired_config,config_fingerprint,health_status)
     values($1,$2,$3,$4,$5,'schedule','active',$6::jsonb,$7,'healthy')`,
    [
      id,
      workspaceId,
      workflowId,
      versionId,
      `misfire-${id}`,
      JSON.stringify({ ...config, misfirePolicy: policy }),
      fingerprint,
    ],
  );
  // The first due instant is the persisted `next_fire_at`; for an
  // every-minute cron it is the first whole minute after the anchor.
  await ownerQuery(
    `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
       interval_minutes,cron_expression,timezone,misfire_policy,config_fingerprint,
       anchor_at,next_fire_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,now()-make_interval(secs=>$9),
       case when $4::integer is null
            then date_trunc('minute',now()-make_interval(secs=>$9))+interval '1 minute'
            else now()-make_interval(secs=>$9)+make_interval(mins=>$4) end)`,
    [
      id,
      workspaceId,
      recurrence.kind,
      recurrence.kind === 'interval' ? recurrence.minutes : null,
      recurrence.kind === 'cron' ? recurrence.expression : null,
      recurrence.kind === 'cron' ? timezone : null,
      policy,
      fingerprint,
      anchorSecondsAgo,
    ],
  );
  return id;
}

function scan(leaseOwner: string, onTimeWindowSeconds = 300) {
  return schedule.scannerOne.scanDue({
    leaseOwner,
    limit: 10,
    leaseSeconds: 30,
    onTimeWindowSeconds,
    checkpointFactory,
  });
}

type ScheduleFacts = Readonly<{
  disposition: string;
  scheduled_at: Date;
  workflow_run_id: string | null;
  occurrences: string;
  last_fire_at: Date | null;
  next_fire_at: Date;
  advanced: boolean;
  health_status: string;
}>;

async function scheduleFacts(triggerId: string): Promise<ScheduleFacts> {
  const result = await ownerQuery<ScheduleFacts>(
    `select occurrence.disposition,occurrence.scheduled_at,occurrence.workflow_run_id,
            (select count(*) from app.trigger_schedule_occurrences
              where trigger_id=$1) occurrences,
            schedule.last_fire_at,schedule.next_fire_at,
            schedule.next_fire_at>clock_timestamp() advanced,schedule.health_status
       from app.trigger_schedules schedule
       join app.trigger_schedule_occurrences occurrence
         on occurrence.trigger_id=schedule.trigger_id
      where schedule.trigger_id=$1
      order by occurrence.scheduled_at desc limit 1`,
    [triggerId],
  );
  const facts = result.rows[0];
  if (facts === undefined) throw new Error('Schedule occurrence missing');
  return facts;
}

async function disable(triggerId: string): Promise<void> {
  await ownerQuery(
    "update app.trigger_schedules set status='disabled' where trigger_id=$1",
    [triggerId],
  );
}

async function scheduleRunCount(): Promise<string> {
  const result = await ownerQuery<{ runs: string }>(
    `select count(*) runs from app.workflow_runs
      where workspace_id=$1 and trigger_type='schedule'`,
    [workspaceId],
  );
  return result.rows[0]?.runs ?? '';
}

beforeAll(async () => {
  await schedule.initialize();
  // Only each scenario's own schedule may be due.
  await ownerQuery(
    "update app.trigger_schedules set status='disabled' where workspace_id=$1",
    [workspaceId],
  );
}, 60_000);
afterAll(schedule.close);

describe('skip misfire on-time window', () => {
  it('admits an on-time skip occurrence through catch-up acceptance, idempotently', async () => {
    // Hourly, anchored 61 minutes ago: the only due occurrence is 1 minute old.
    const triggerId = await insertSchedule(
      'skip',
      { kind: 'interval', minutes: 60 },
      61 * 60,
    );
    await expect(scan('on-time-scanner')).resolves.toMatchObject({
      claimed: 1,
      accepted: 1,
      skipped: 0,
    });
    const facts = await scheduleFacts(triggerId);
    expect(facts).toMatchObject({
      disposition: 'accepted',
      occurrences: '1',
      advanced: true,
      health_status: 'healthy',
    });
    expect(facts.last_fire_at).toEqual(facts.scheduled_at);
    expect(facts.next_fire_at.getTime()).toBe(
      facts.scheduled_at.getTime() + 60 * 60_000,
    );
    const identity = `${triggerId}:${facts.scheduled_at.toISOString()}`;
    const admitted = await ownerQuery(
      `select run.trigger_type,record.operation,
              exists(select 1 from app.outbox_events event
                      where event.aggregate_id=run.id) has_outbox
         from app.workflow_runs run
         join app.idempotency_records record on record.resource_id=run.id
        where run.id=$1 and record.scope=$2 and record.key_hash=$3`,
      [
        facts.workflow_run_id,
        `schedule:${triggerId}`,
        createHash('sha256').update(identity).digest('hex'),
      ],
    );
    expect(admitted.rows).toEqual([
      {
        trigger_type: 'schedule',
        operation: 'workflow.run.accept',
        has_outbox: true,
      },
    ]);

    // Rescanning the same occurrence replays its acceptance: no second run.
    const runs = await scheduleRunCount();
    await ownerQuery(
      `update app.trigger_schedules set last_fire_at=null,next_fire_at=$2
        where trigger_id=$1`,
      [triggerId, facts.scheduled_at],
    );
    await expect(scan('on-time-rescanner')).resolves.toMatchObject({
      accepted: 1,
    });
    await expect(scheduleFacts(triggerId)).resolves.toMatchObject({
      workflow_run_id: facts.workflow_run_id,
      occurrences: '1',
    });
    await expect(scheduleRunCount()).resolves.toBe(runs);
    await disable(triggerId);
  });

  it('records only the latest late skip occurrence and advances past the observation', async () => {
    // Every 30 minutes, anchored 100 minutes ago: occurrences 70, 40 and 10
    // minutes ago are due; only the latest is decided, and it is late.
    const runs = await scheduleRunCount();
    const triggerId = await insertSchedule(
      'skip',
      { kind: 'interval', minutes: 30 },
      100 * 60,
    );
    await expect(scan('late-scanner')).resolves.toMatchObject({
      claimed: 1,
      accepted: 0,
      skipped: 1,
    });
    const facts = await scheduleFacts(triggerId);
    expect(facts).toMatchObject({
      disposition: 'skipped',
      workflow_run_id: null,
      occurrences: '1',
      advanced: true,
      health_status: 'healthy',
    });
    expect(facts.last_fire_at).toEqual(facts.scheduled_at);
    expect(facts.next_fire_at.getTime()).toBe(
      facts.scheduled_at.getTime() + 30 * 60_000,
    );
    await expect(scheduleRunCount()).resolves.toBe(runs);
    await disable(triggerId);
  });

  it('applies the configured window to either side of its boundary', async () => {
    // Hourly schedules whose due occurrence is 110 and 130 seconds old,
    // scanned with a 120-second window. Ten seconds of margin absorbs the
    // time between inserting a schedule and the scanner's observation.
    const cases = [
      [110, 'accepted'],
      [130, 'skipped'],
    ] as const;
    for (const [lateSeconds, disposition] of cases) {
      const triggerId = await insertSchedule(
        'skip',
        { kind: 'interval', minutes: 60 },
        60 * 60 + lateSeconds,
      );
      await expect(
        scan(`boundary-${String(lateSeconds)}`, 120),
      ).resolves.toMatchObject({
        claimed: 1,
        accepted: disposition === 'accepted' ? 1 : 0,
        skipped: disposition === 'skipped' ? 1 : 0,
      });
      await expect(scheduleFacts(triggerId)).resolves.toMatchObject({
        disposition,
        advanced: true,
      });
      await disable(triggerId);
    }
  });

  it('admits an every-minute cron skip schedule, which is always on time', async () => {
    const triggerId = await insertSchedule(
      'skip',
      { kind: 'cron', expression: '* * * * *' },
      10 * 60,
    );
    await expect(scan('cron-scanner', 60)).resolves.toMatchObject({
      claimed: 1,
      accepted: 1,
    });
    const facts = await scheduleFacts(triggerId);
    expect(facts).toMatchObject({ disposition: 'accepted', occurrences: '1' });
    expect(facts.scheduled_at.getUTCSeconds()).toBe(0);
    expect(facts.workflow_run_id).not.toBeNull();
    await disable(triggerId);
  });

  it('keeps catch-up admission for an occurrence far outside the window', async () => {
    const triggerId = await insertSchedule(
      'catch_up_once',
      { kind: 'interval', minutes: 30 },
      100 * 60,
    );
    await expect(scan('catch-up-scanner', 60)).resolves.toMatchObject({
      claimed: 1,
      accepted: 1,
      skipped: 0,
    });
    const facts = await scheduleFacts(triggerId);
    expect(facts).toMatchObject({
      disposition: 'accepted',
      occurrences: '1',
      advanced: true,
    });
    expect(facts.workflow_run_id).not.toBeNull();
    expect(Date.now() - facts.scheduled_at.getTime()).toBeGreaterThan(
      9 * 60_000,
    );
    await disable(triggerId);
  });
});
