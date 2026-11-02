import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InitialCheckpointFactory } from '../../../src/runs/commands/initial-checkpoint.js';
import { createScheduleTriggerTestEnvironment } from '../../support/schedule-triggers.js';

type WorkspaceId = ReturnType<typeof randomUUID>;

const schedule = createScheduleTriggerTestEnvironment();
const { actorId, checkpointFactory, ownerQuery } = schedule;

beforeAll(async () => {
  await schedule.initialize();
  await ownerQuery(
    `update app.trigger_schedules set status='disabled' where trigger_id=any($1::uuid[])`,
    [[schedule.triggerId, schedule.skipTriggerId]],
  );
}, 60_000);
afterAll(schedule.close);

/** A published workflow with a due schedule, this overdue. */
async function dueSchedule(
  workspaceId: WorkspaceId,
  overdue: string,
): Promise<Readonly<{ triggerId: string; versionId: string }>> {
  const workflowId = randomUUID();
  const versionId = randomUUID();
  const triggerId = randomUUID();
  const query = (statement: string, parameters: unknown[]) =>
    ownerQuery(statement, parameters, workspaceId);
  await query(
    `insert into app.workflows(id,workspace_id,name,lifecycle_status,activation_status,created_by)
     values($1,$2,'Scheduled','active','active',$3)`,
    [workflowId, workspaceId, actorId],
  );
  await query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     values($1,$2,$3,1,'{"settings":{},"nodes":[],"edges":[]}'::jsonb,$4,'{}'::jsonb,$5)`,
    [
      versionId,
      workspaceId,
      workflowId,
      `wf:sha256:${'a'.repeat(64)}`,
      actorId,
    ],
  );
  await query('update app.workflows set published_version_id=$2 where id=$1', [
    workflowId,
    versionId,
  ]);
  const fingerprint = `trigger:sha256:${createHash('sha256').update(triggerId).digest('hex')}`;
  await query(
    `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
       node_id,kind,status,desired_config,config_fingerprint,health_status)
     values($1,$2,$3,$4,'schedule','schedule','active',$5::jsonb,$6,'healthy')`,
    [
      triggerId,
      workspaceId,
      workflowId,
      versionId,
      JSON.stringify({
        kind: 'interval',
        intervalMinutes: 60,
        misfirePolicy: 'catch_up_once',
      }),
      fingerprint,
    ],
  );
  await query(
    `insert into app.trigger_schedules(trigger_id,workspace_id,recurrence_kind,
       interval_minutes,misfire_policy,config_fingerprint,anchor_at,next_fire_at)
     values($1,$2,'interval',60,'catch_up_once',$3,
       clock_timestamp()-$4::interval-interval '1 hour',clock_timestamp()-$4::interval)`,
    [triggerId, workspaceId, fingerprint, overdue],
  );
  return { triggerId, versionId };
}

async function createWorkspace(): Promise<WorkspaceId> {
  const id = randomUUID();
  await schedule.identity.createWorkspaceWithOwner({
    id,
    name: 'Another Schedule Workspace',
    slug: `schedule-${id}`,
    ownerUserId: actorId,
    idempotencyKey: `schedule-${id}`,
  });
  return id;
}

async function firedRuns(
  workspaceId: WorkspaceId,
  triggerId: string,
): Promise<number> {
  const { rows } = await ownerQuery<{ runs: number }>(
    `select count(workflow_run_id)::int runs from app.trigger_schedule_occurrences
      where trigger_id=$1`,
    [triggerId],
    workspaceId,
  );
  return rows[0]?.runs ?? 0;
}

const scan = (factory: InitialCheckpointFactory = checkpointFactory) =>
  schedule.scannerOne.scanDue({
    leaseOwner: 'scanner',
    limit: 10,
    leaseSeconds: 30,
    onTimeWindowSeconds: 300,
    checkpointFactory: factory,
  });

describe('a schedule that cannot fire', () => {
  it('does not stop the other schedules claimed in the same scan', async () => {
    const [first, second] = [await createWorkspace(), await createWorkspace()];
    const broken = await dueSchedule(first, '3 hours');
    const healthy = await dueSchedule(second, '2 hours');
    await expect(
      scan((projection) => {
        if (projection.id === broken.versionId)
          throw new Error('this version cannot run');
        return checkpointFactory(projection);
      }),
    ).rejects.toThrow('this version cannot run');
    expect(await firedRuns(first, broken.triggerId)).toBe(0);
    expect(await firedRuns(second, healthy.triggerId)).toBe(1);
  }, 30_000);

  it('does not keep the rest of its workspace from firing', async () => {
    const workspaceId = await createWorkspace();
    const broken = await dueSchedule(workspaceId, '3 hours');
    const healthy = await dueSchedule(workspaceId, '2 hours');
    await expect(
      scan((projection) => {
        if (projection.id === broken.versionId)
          throw new Error('this version cannot run');
        return checkpointFactory(projection);
      }),
    ).rejects.toThrow('this version cannot run');
    // A scan claims one schedule per workspace, the most overdue.
    await scan();
    expect(await firedRuns(workspaceId, healthy.triggerId)).toBe(1);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [broken.triggerId],
        workspaceId,
      ),
    ).resolves.toMatchObject({
      rows: [
        { health_status: 'degraded', last_error_code: 'schedule.scan_failed' },
      ],
    });
  }, 30_000);

  it('treats a workflow archived before reconciliation as no failure, and moves on', async () => {
    const workspaceId = await createWorkspace();
    const archived = await dueSchedule(workspaceId, '3 hours');
    const healthy = await dueSchedule(workspaceId, '2 hours');
    await ownerQuery(
      `update app.workflows set lifecycle_status='archived'
        where id=(select workflow_id from app.workflow_triggers where id=$1)`,
      [archived.triggerId],
      workspaceId,
    );
    await expect(scan()).resolves.toMatchObject({ accepted: 0, deferred: 1 });
    await expect(scan()).resolves.toMatchObject({ accepted: 1 });
    expect(await firedRuns(workspaceId, archived.triggerId)).toBe(0);
    expect(await firedRuns(workspaceId, healthy.triggerId)).toBe(1);
  }, 30_000);

  it('reports every failure of a batch together, and fires what it can', async () => {
    const [first, second, third] = [
      await createWorkspace(),
      await createWorkspace(),
      await createWorkspace(),
    ];
    const one = await dueSchedule(first, '3 hours');
    const other = await dueSchedule(second, '3 hours');
    const healthy = await dueSchedule(third, '2 hours');
    const cannotRun = new Set([one.versionId, other.versionId]);

    const failure: unknown = await scan((projection) => {
      if (cannotRun.has(projection.id))
        throw new Error(`cannot run ${projection.id}`);
      return checkpointFactory(projection);
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(
      (failure as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(
      expect.arrayContaining([
        `cannot run ${one.versionId}`,
        `cannot run ${other.versionId}`,
      ]),
    );
    expect(await firedRuns(third, healthy.triggerId)).toBe(1);
  }, 30_000);

  it('rests a minute by the database’s clock, is left alone, then tries again', async () => {
    const workspaceId = await createWorkspace();
    const broken = await dueSchedule(workspaceId, '3 hours');
    const attempts: string[] = [];
    const factory: InitialCheckpointFactory = (projection) => {
      attempts.push(projection.id);
      if (projection.id === broken.versionId)
        throw new Error('this version cannot run');
      return checkpointFactory(projection);
    };

    await expect(scan(factory)).rejects.toThrow('this version cannot run');
    const rest = await ownerQuery<{ seconds: number; leased: boolean }>(
      `select extract(epoch from admission_deferred_until-clock_timestamp())::float8 seconds,
              lease_token is not null leased
         from app.trigger_schedules where trigger_id=$1`,
      [broken.triggerId],
      workspaceId,
    );
    expect(rest.rows[0]?.leased).toBe(false);
    expect(rest.rows[0]?.seconds).toBeGreaterThan(30);
    expect(rest.rows[0]?.seconds).toBeLessThanOrEqual(60);

    await scan(factory);
    expect(attempts.filter((id) => id === broken.versionId)).toHaveLength(1);

    await ownerQuery(
      `update app.trigger_schedules
          set admission_deferred_until=clock_timestamp()-interval '1 second'
        where trigger_id=$1`,
      [broken.triggerId],
      workspaceId,
    );
    await scan();
    expect(await firedRuns(workspaceId, broken.triggerId)).toBe(1);
    await expect(
      ownerQuery(
        `select health_status,last_error_code from app.trigger_schedules where trigger_id=$1`,
        [broken.triggerId],
        workspaceId,
      ),
    ).resolves.toMatchObject({
      rows: [{ health_status: 'healthy', last_error_code: null }],
    });
  }, 30_000);

  const leaseOf = async (workspaceId: WorkspaceId, triggerId: string) => {
    const { rows } = await ownerQuery<{ lease_token: string | null }>(
      `select lease_token from app.trigger_schedules where trigger_id=$1`,
      [triggerId],
      workspaceId,
    );
    return rows[0]?.lease_token;
  };

  it('gives back the rest of the batch when the scan is cancelled', async () => {
    const [first, second, third] = [
      await createWorkspace(),
      await createWorkspace(),
      await createWorkspace(),
    ];
    const started = await dueSchedule(first, '4 hours');
    const next = await dueSchedule(second, '3 hours');
    const last = await dueSchedule(third, '2 hours');
    const shutdown = new AbortController();
    const reason = new Error('the worker is stopping');

    await expect(
      schedule.scannerOne.scanDue({
        leaseOwner: 'scanner',
        limit: 10,
        leaseSeconds: 30,
        onTimeWindowSeconds: 300,
        signal: shutdown.signal,
        checkpointFactory: (projection) => {
          if (projection.id === started.versionId) shutdown.abort(reason);
          return checkpointFactory(projection);
        },
      }),
    ).rejects.toBeDefined();

    expect(await firedRuns(second, next.triggerId)).toBe(0);
    expect(await firedRuns(third, last.triggerId)).toBe(0);
    expect(await leaseOf(second, next.triggerId)).toBeNull();
    expect(await leaseOf(third, last.triggerId)).toBeNull();

    // Given back, not resting: the next worker's scan takes them at once.
    await scan();
    expect(await firedRuns(second, next.triggerId)).toBe(1);
    expect(await firedRuns(third, last.triggerId)).toBe(1);
  }, 30_000);

  // A database that can't record the failure can't be trusted with the rest, and what
  // an operator needs to read is why the claim failed, not why it couldn't be retired.
  it('stops at a claim it can’t retire, says what went wrong first, and gives back the rest', async () => {
    const [first, second] = [await createWorkspace(), await createWorkspace()];
    const broken = await dueSchedule(first, '3 hours');
    const healthy = await dueSchedule(second, '2 hours');
    const signature = 'app.fail_trigger_schedule_claim(uuid, uuid)';
    await ownerQuery(`revoke execute on function ${signature} from public`, []);
    await ownerQuery(
      `revoke execute on function ${signature} from pertexo_app`,
      [],
    );
    try {
      await expect(
        scan((projection) => {
          if (projection.id === broken.versionId)
            throw new Error('this version cannot run');
          return checkpointFactory(projection);
        }),
      ).rejects.toThrow('this version cannot run');

      expect(await firedRuns(second, healthy.triggerId)).toBe(0);
      expect(await leaseOf(second, healthy.triggerId)).toBeNull();
      // Couldn't be retired, so it keeps its lease until that runs out.
      expect(await leaseOf(first, broken.triggerId)).not.toBeNull();
    } finally {
      await ownerQuery(
        `grant execute on function ${signature} to pertexo_app`,
        [],
      );
    }

    await scan();
    expect(await firedRuns(second, healthy.triggerId)).toBe(1);
  }, 30_000);
});
