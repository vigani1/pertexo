import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { canonicalOutboxPayloadChecksum } from '@pertexo/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';
import {
  createTestRunStore,
  type TestRunStore,
} from '../../support/run-advance-store.js';

const schedule = createScheduleTriggerTestEnvironment();
const { checkpointFactory, ownerQuery, skipTriggerId, triggerId, workflowId } =
  schedule;
const signal = new AbortController().signal;
let store: TestRunStore;

beforeAll(async () => {
  await schedule.initialize();
  await ownerQuery(
    `update app.trigger_schedules set next_fire_at=clock_timestamp()+interval '1 hour'
      where trigger_id=$1`,
    [skipTriggerId],
  );
  // The fixture's version never has to run. An advance reads this much of it.
  await ownerQuery(
    `update app.workflow_versions set executable_json='{"graph":{"nodes":[],"edges":[]}}'::jsonb
      where workflow_id=$1`,
    [workflowId],
  );
  store = createTestRunStore(
    parseDatabaseConfig({ connectionString: schedule.apiConnectionString }),
  );
}, 60_000);

afterAll(async () => {
  await store.close();
  await schedule.close();
});

/** An occurrence this late, within the schedule's minute, with a run waiting to start. */
async function fireScheduleLateBy(seconds: number) {
  await ownerQuery(
    `update app.trigger_schedules
        set last_fire_at=null,admission_deferred_until=null,lease_owner=null,lease_token=null,
            lease_acquired_at=null,lease_expires_at=null,
            anchor_at=date_trunc('milliseconds',clock_timestamp())-make_interval(secs=>$2+60),
            next_fire_at=date_trunc('milliseconds',clock_timestamp())-make_interval(secs=>$2)
      where trigger_id=$1`,
    [triggerId, seconds],
  );
  await expect(
    schedule.scannerOne.scanDue({
      leaseOwner: 'scanner',
      limit: 10,
      leaseSeconds: 30,
      onTimeWindowSeconds: seconds + 300,
      checkpointFactory,
    }),
  ).resolves.toMatchObject({ accepted: 1 });
  const { rows } = await ownerQuery<{
    id: string;
    scheduled_at: string;
    outbox_id: string;
    checksum: string;
  }>(
    `select r.id, r.input_ref->'value'->>'scheduledAt' scheduled_at,
            e.id outbox_id, e.payload_checksum checksum
       from app.workflow_runs r
       join app.outbox_events e on e.aggregate_id=r.id and e.job_name='advance-workflow-run'
      where r.workflow_id=$1 and r.trigger_type='schedule'
      order by r.created_at desc limit 1`,
    [workflowId],
  );
  const [run] = rows;
  if (run === undefined) throw new Error('Expected the scheduled run');
  return run;
}

async function commitStart(
  run: Awaited<ReturnType<typeof fireScheduleLateBy>>,
) {
  const input = { workspaceId: schedule.workspaceId, runId: run.id };
  const loaded = await store.loadAdvanceState(input);
  if (loaded.kind !== 'ready') throw new Error('Expected the run to load');
  const current = loaded.state.checkpoint as Readonly<{
    revision: number;
    nextEventSequence: number;
  }>;
  const sequence = current.nextEventSequence;
  return store.commitAdvancePlan({
    ...input,
    signal,
    delivery: {
      outboxEventId: run.outbox_id,
      payloadChecksum: run.checksum,
    },
    plan: {
      expectedRevision: current.revision,
      expectedNextEventSequence: sequence,
      consumedThroughEventSequence: sequence - 1,
      checkpoint: {
        ...current,
        revision: current.revision + 1,
        runStatus: 'running',
        nextEventSequence: sequence + 1,
      },
      events: [
        { sequence, name: 'run.started', occurredAt: loaded.state.occurredAt },
      ],
      nodeRunAdmissions: [],
      attempts: [],
    },
  });
}

async function nextDelivery(runId: string) {
  const outboxEventId = randomUUID();
  const payload = {
    workspaceId: schedule.workspaceId,
    runId,
    outboxEventId,
  };
  const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
  await ownerQuery(
    `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum)
     values($1,$2,'advance-workflow-run','workflow-run',$3,$4::jsonb,$5)`,
    [
      outboxEventId,
      schedule.workspaceId,
      runId,
      JSON.stringify(payload),
      payloadChecksum,
    ],
  );
  return { outboxEventId, payloadChecksum };
}

const databaseNow = async () => {
  const { rows } = await ownerQuery<{ now: Date }>(
    'select clock_timestamp() "now"',
    [],
  );
  return (rows[0]?.now ?? new Date(0)).getTime();
};

describe('how long a scheduled run took to start', () => {
  // The metric used to come from a second connection after the commit.
  it('comes back from the first commit of a real scheduled run', async () => {
    const run = await fireScheduleLateBy(30);

    const result = await commitStart(run);
    const expected =
      ((await databaseNow()) - new Date(run.scheduled_at).getTime()) / 1_000;

    if (result.kind !== 'committed') throw new Error('Expected a commit');
    expect(result.scheduleToStartSeconds).toBeGreaterThanOrEqual(30);
    expect(
      Math.abs((result.scheduleToStartSeconds ?? 0) - expected),
    ).toBeLessThan(30);
  });

  it('isn’t measured again once the run has started', async () => {
    const run = await fireScheduleLateBy(30);
    await commitStart(run);
    const input = { workspaceId: schedule.workspaceId, runId: run.id };
    const loaded = await store.loadAdvanceState(input);
    if (loaded.kind !== 'ready') throw new Error('Expected the run to load');
    const current = loaded.state.checkpoint as Readonly<{
      revision: number;
      nextEventSequence: number;
    }>;

    const result = await store.commitAdvancePlan({
      ...input,
      signal,
      delivery: await nextDelivery(run.id),
      plan: {
        expectedRevision: current.revision,
        expectedNextEventSequence: current.nextEventSequence,
        consumedThroughEventSequence: current.nextEventSequence - 1,
        checkpoint: {
          ...current,
          revision: current.revision + 1,
          nextEventSequence: current.nextEventSequence,
        },
        events: [],
        nodeRunAdmissions: [],
        attempts: [],
      },
    });

    expect(result.kind).toBe('committed');
    expect(result).not.toHaveProperty('scheduleToStartSeconds');
  });
});
