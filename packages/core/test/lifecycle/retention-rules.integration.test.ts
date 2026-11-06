import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  admin,
  daysAgo,
  enforceUntilIdle,
  DAY,
  inline,
  insertRun,
  insertExecutionDetail,
  count,
  runRow,
  insertScheduleTrigger,
  insertOccurrence,
} from './retention-rules.fixture.js';
import {
  randomUUID,
  retention,
  userId,
  workspaceId,
  runIds,
  adminUrl,
  maintenanceUrl,
  withDatabase,
  withApplicationName,
  waitForPostgresLock,
} from './retention.support.js';
import { generatePersistedId } from '@pertexo/database/platform';
import { Client, Pool, type QueryConfig } from 'pg';
import { RETENTION_RULES } from '../../src/lifecycle/retention/rules.js';

/** The run summary window a person is told about. */
const WINDOW_DAYS = 90;

async function usage(category: string, ageDays: number): Promise<string> {
  const id = generatePersistedId();
  await admin.query(
    `insert into app.usage_events(id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata,occurred_at)
     values($1,$2,$3,1,'preview_run',$4,$5,'{}'::jsonb,$6)`,
    [id, workspaceId, category, randomUUID(), randomUUID(), daysAgo(ageDays)],
  );
  return id;
}

const remaining = async (ids: readonly string[]) => {
  const { rows } = await admin.query<{ id: string }>(
    'select id from app.usage_events where id=any($1::uuid[])',
    [ids],
  );
  return rows.map(({ id }) => id).sort();
};

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
describe('retention rules', () => {
  it('retains connection events according to each workspace audit setting', async () => {
    const workspaceId = randomUUID();
    const otherWorkspace = randomUUID();
    for (const [ws, days] of [
      [workspaceId, 30],
      [otherWorkspace, 365],
    ] as const)
      await admin.query(
        "insert into app.workspaces(id,name,slug,created_by,audit_retention_days) values($1,'Retention',$2,$3,$4)",
        [ws, `retention-${ws}`, userId, days],
      );
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const [index, ws] of [workspaceId, otherWorkspace].entries()) {
      const connection = randomUUID();
      const secret = randomUUID();
      await admin.query(
        `with inserted_connection as (insert into app.connections(id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by)
         values($1,$2,'email','Retention','resend_api_key','active',$3,$4) returning id)
         insert into app.connection_secret_versions(id,workspace_id,connection_id,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by)
         select $3,$2,id,'kms','key','cipher','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4 from inserted_connection`,
        [connection, ws, secret, userId],
      );
      for (const [id, age] of index === 0
        ? [
            [ids[0], 40],
            [ids[1], 29],
            [ids[2], 10],
          ]
        : [[ids[3], 40]]) {
        await admin.query(
          "insert into app.connection_events(id,workspace_id,connection_id,event_type,actor_kind,actor_id,created_at) values($1,$2,$3,'connection.created','system','retention-test',$4)",
          [id, ws, connection, daysAgo(Number(age))],
        );
      }
    }
    const result = await retention.enforce();
    expect(result.removed.connection_events).toBe(1);
    await enforceUntilIdle();
    const rows = await admin.query<{ id: string }>(
      'select id from app.connection_events where id=any($1::uuid[])',
      [ids],
    );
    expect(rows.rows.map((row) => row.id).sort()).toEqual(ids.slice(1).sort());
  });
  it('lets a step test usage row go at the run summary window, and nothing else with it', async () => {
    const expired = await usage('preview_execution', WINDOW_DAYS + 1);
    const recent = await usage('preview_execution', WINDOW_DAYS - 1);
    const otherOldCategory = await usage('preview.execution', WINDOW_DAYS + 30);

    await enforceUntilIdle();

    expect(await remaining([expired, recent, otherOldCategory])).toEqual(
      [recent, otherOldCategory].sort(),
    );
  });

  it('works through more than a page, and reports what it removed', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1)
      ids.push(await usage('preview_execution', WINDOW_DAYS + 1));

    let removed = 0;
    let passes = 0;
    for (; passes < 50; passes += 1) {
      const pass = await retention.enforce();
      removed += pass.removed.preview_usage;
      if (!pass.more) break;
    }

    expect(removed).toBe(ids.length);
    // The fixture's page is 2, so this took several passes.
    expect(passes).toBeGreaterThan(1);
    expect(await remaining(ids)).toEqual([]);
  });

  it('leaves a skipped trigger to its own rule', async () => {
    const skip = await usage('trigger.skipped', WINDOW_DAYS + 1);
    const first = await retention.enforce();
    expect(first.removed.preview_usage).toBe(0);
    await enforceUntilIdle();
    expect(await remaining([skip])).toEqual([]);
  });
  it('removes sign-in proof rows a day after expiry, retaining recent and live journeys', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      let created;
      if (index === 0) {
        created = daysAgo(3);
      } else {
        if (index === 1) {
          created = daysAgo(0.1);
        } else {
          created = new Date();
        }
      }
      let expires;
      if (index === 0) {
        expires = daysAgo(2);
      } else {
        if (index === 1) {
          expires = daysAgo(0.05);
        } else {
          expires = new Date(Date.now() + 300_000);
        }
      }
      await admin.query(
        `insert into app.auth_sign_in_attempts
        (id,provider,state_digest,browser_digest,return_path,created_at,expires_at)
        values($1,'google',$2,$3,'/workspaces',$4,$5)`,
        [
          id,
          Buffer.alloc(32, index + 1),
          Buffer.alloc(32, 9),
          created,
          expires,
        ],
      );
    }
    const result = await retention.enforce();
    expect(result.removed.auth_sign_in_attempts).toBe(1);
    const rows = await admin.query<{ id: string }>(
      'select id from app.auth_sign_in_attempts where id=any($1::uuid[])',
      [ids],
    );
    expect(rows.rows.map((row) => row.id).sort()).toEqual(ids.slice(1).sort());
  });

  it('clears expired terminal input while retaining an expired live run input', async () => {
    await admin.query(
      "update app.workflow_runs set status='succeeded',completed_at=clock_timestamp() where id=any($1::uuid[])",
      [runIds],
    );
    const pending = randomUUID();
    await admin.query(
      `insert into app.workflow_runs
        (id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,
         input_ref,input_ref_expires_at,created_at)
       values($1,$2,$3,$4,'manual','queued',$5::jsonb,$6,$6::timestamptz-interval '30 days')`,
      [
        pending,
        workspaceId,
        randomUUID(),
        randomUUID(),
        inline('kept'),
        new Date(Date.now() - DAY),
      ],
    );

    // Pages of two: the four expired fixture inputs take two passes.
    const first = await retention.enforce();
    expect(first.removed.run_inputs).toBe(2);
    expect(first.more).toBe(true);
    await enforceUntilIdle();

    const inputs = await admin.query<{ id: string; input_ref: unknown }>(
      'select id,input_ref from app.workflow_runs where id = any($1::uuid[])',
      [[...runIds, pending]],
    );
    expect(
      Object.fromEntries(inputs.rows.map((row) => [row.id, row.input_ref])),
    ).toEqual({
      ...Object.fromEntries(runIds.map((id) => [id, null])),
      [pending]: { kind: 'inline', value: 'kept' },
    });
  });

  it('purges execution details 30 days after completion and keeps the summary', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    const recent = await insertRun({ completedDaysAgo: 10 });
    await insertExecutionDetail(old);
    await insertExecutionDetail(recent);

    await enforceUntilIdle();

    expect(await count('node_runs', old)).toBe(0);
    expect(await count('run_events', old)).toBe(0);
    expect(await runRow(old)).toMatchObject({
      output_ref: null,
      error_summary: null,
      details_purged_at: expect.any(Date) as unknown,
    });
    expect(await count('node_runs', recent)).toBe(1);
    expect(await count('run_events', recent)).toBe(1);
    expect(await runRow(recent)).toMatchObject({
      error_summary: 'failure detail',
      details_purged_at: null,
    });
  });

  it('deletes run summaries after 90 days once nothing refers to them', async () => {
    const triggerId = await insertScheduleTrigger();
    const unreferenced = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replaySource = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const replayChild = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
      replaySourceRunId: replaySource,
    });
    const scheduled = await insertRun({
      completedDaysAgo: 100,
      detailsPurged: true,
    });
    const recentOccurrence = await insertOccurrence(triggerId, 10, scheduled);
    const tooRecent = await insertRun({
      completedDaysAgo: 80,
      detailsPurged: true,
    });

    await enforceUntilIdle();

    const remaining = await admin.query<{ id: string }>(
      'select id from app.workflow_runs where id = any($1::uuid[])',
      [[unreferenced, replaySource, replayChild, scheduled, tooRecent]],
    );
    // The replay child goes first, then its source on a later page.
    expect(remaining.rows.map(({ id }) => id).sort()).toEqual(
      [scheduled, tooRecent].sort(),
    );
    const occurrences = await admin.query(
      'select 1 from app.trigger_schedule_occurrences where id=$1',
      [recentOccurrence],
    );
    expect(occurrences.rowCount).toBe(1);
  });

  it('deletes schedule occurrences after 90 days and audit records after a year', async () => {
    const triggerId = await insertScheduleTrigger();
    const oldOccurrence = await insertOccurrence(triggerId, 100);
    const recentOccurrence = await insertOccurrence(triggerId, 30);
    const oldAudit = randomUUID();
    const recentAudit = randomUUID();
    for (const [id, days] of [
      [oldAudit, 400],
      [recentAudit, 300],
    ] as const)
      await admin.query(
        `insert into app.audit_events(id,workspace_id,action,target_type,occurred_at)
         values($1,$2,'retention.test','workspace',$3)`,
        [id, workspaceId, daysAgo(days)],
      );

    await enforceUntilIdle();

    const occurrences = await admin.query<{ id: string }>(
      'select id from app.trigger_schedule_occurrences where id = any($1::uuid[])',
      [[oldOccurrence, recentOccurrence]],
    );
    expect(occurrences.rows.map(({ id }) => id)).toEqual([recentOccurrence]);
    const audit = await admin.query<{ id: string }>(
      'select id from app.audit_events where id = any($1::uuid[])',
      [[oldAudit, recentAudit]],
    );
    expect(audit.rows.map(({ id }) => id)).toEqual([recentAudit]);
  });

  it('skips locked expired audit rows without locking workspace settings', async () => {
    await enforceUntilIdle();
    const held = randomUUID(),
      next = randomUUID(),
      fresh = randomUUID();
    for (const [id, days] of [
      [held, 500],
      [next, 499],
      [fresh, 100],
    ] as const)
      await admin.query(
        "insert into app.audit_events(id,workspace_id,action,target_type,occurred_at) values($1,$2,'retention.lock','workspace',$3)",
        [id, workspaceId, daysAgo(days)],
      );
    const rule = RETENTION_RULES.find(
      (candidate) => candidate.name === 'audit_events',
    );
    if (rule === undefined || !('run' in rule))
      throw new Error('Missing audit rule');
    const blocker = new Client({ connectionString: withDatabase(adminUrl) });
    const cleanerPool = new Pool({ connectionString: maintenanceUrl, max: 1 });
    await blocker.connect();
    const cleaner = await cleanerPool.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        'select id from app.audit_events where id=$1 for update',
        [held],
      );
      await cleaner.query('begin');
      await cleaner.query("set local statement_timeout='1s'");
      expect(await rule.run(cleaner, 1)).toBe(1);
      expect(await rule.run(cleaner, 1)).toBe(0);
      expect(
        (
          await admin.query(
            'select id from app.audit_events where id=any($1::uuid[]) order by id',
            [[held, fresh]],
          )
        ).rows.map((row: { id: string }) => row.id),
      ).toEqual([held, fresh].sort());
      // The cleaner still owns its page locks; settings must remain independently writable.
      await admin.query("set statement_timeout='1s'");
      await admin.query(
        'update app.workspaces set audit_retention_days=audit_retention_days where id=$1',
        [workspaceId],
      );
      await cleaner.query('commit');
      await blocker.query('commit');
      expect(await rule.run(cleaner, 1)).toBe(1);
      expect(
        (
          await admin.query(
            'select id from app.audit_events where id=any($1::uuid[])',
            [[held, next, fresh]],
          )
        ).rows,
      ).toEqual([{ id: fresh }]);
    } finally {
      await admin.query('reset statement_timeout');
      await cleaner.query('rollback');
      await blocker.query('rollback');
      cleaner.release();
      await cleanerPool.end();
      await blocker.end();
    }
  });

  it('uses the audit time index on a populated ledger and honors each workspace retention', async () => {
    await enforceUntilIdle();
    const otherWorkspace = randomUUID(),
      retained = randomUUID(),
      due = randomUUID();
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by,audit_retention_days) values($1::uuid,'Long retention',$1::text,$2,2555)",
      [otherWorkspace, userId],
    );
    await admin.query(
      "insert into app.audit_events(id,workspace_id,action,target_type,occurred_at) select gen_random_uuid(),$1,'retention.index','workspace',clock_timestamp()-interval '1 day' from generate_series(1,20000)",
      [workspaceId],
    );
    for (const [id, days] of [
      [retained, 400],
      [due, 2600],
    ] as const)
      await admin.query(
        "insert into app.audit_events(id,workspace_id,action,target_type,occurred_at) values($1,$2,'retention.index','workspace',$3)",
        [id, otherWorkspace, daysAgo(days)],
      );
    await admin.query('analyze app.audit_events');
    await admin.query('analyze app.workspaces');
    const rule = RETENTION_RULES.find(
      (candidate) => candidate.name === 'audit_events',
    );
    if (rule === undefined || !('run' in rule))
      throw new Error('Missing audit rule');
    const cleanerPool = new Pool({ connectionString: maintenanceUrl, max: 1 });
    const cleaner = await cleanerPool.connect();
    try {
      let plan: unknown;
      const explained = new Proxy(cleaner, {
        get(target, property) {
          if (property !== 'query') {
            const value: unknown = Reflect.get(target, property);
            return value;
          }
          return async (
            statement: QueryConfig<unknown[]>,
            values?: unknown[],
          ) => {
            const result = await target.query(
              { ...statement, text: `explain (format json) ${statement.text}` },
              values,
            );
            plan = result.rows;
            return result;
          };
        },
      });
      await rule.run(explained, 100);
      expect(JSON.stringify(plan)).toContain('audit_events_workspace_time_idx');
      expect(await rule.run(cleaner, 100)).toBe(1);
      expect(
        (
          await admin.query(
            'select id from app.audit_events where id=any($1::uuid[])',
            [[retained, due]],
          )
        ).rows,
      ).toEqual([{ id: retained }]);
      expect(
        (
          await admin.query(
            "select count(*)::int count from app.audit_events where workspace_id=$1 and action='retention.index'",
            [workspaceId],
          )
        ).rows,
      ).toEqual([{ count: 20000 }]);
    } finally {
      cleaner.release();
      await cleanerPool.end();
    }
  });

  it('expires skip summaries in bounded pages while keeping recent skips and other usage', async () => {
    const old = [randomUUID(), randomUUID(), randomUUID()];
    const recent = randomUUID();
    const other = randomUUID();
    for (const id of [...old, recent, other])
      await admin.query(
        `insert into app.usage_events
          (id,workspace_id,category,quantity,resource_type,resource_id,idempotency_key,metadata,occurred_at)
         values($1::uuid,$2,$3,1,'workflow',$4,$1::text,'{}',$5)`,
        [
          id,
          workspaceId,
          id === other ? 'preview.execution' : 'trigger.skipped',
          randomUUID(),
          daysAgo(id === recent ? 80 : 100),
        ],
      );

    const first = await retention.enforce();
    expect(first.removed.trigger_skips).toBe(2);
    expect(first.more).toBe(true);
    await enforceUntilIdle();
    const remaining = await admin.query<{ id: string }>(
      'select id from app.usage_events where id=any($1::uuid[])',
      [[...old, recent, other]],
    );
    expect(remaining.rows.map(({ id }) => id).sort()).toEqual(
      [recent, other].sort(),
    );
  });

  it('keeps a long-active capacity warning without forcing another episode', async () => {
    const id = randomUUID();
    await admin.query(
      `insert into app.workspace_inbox_threads
       (workspace_id,id,notice_kind,subject_id,capacity_limit,active,source_revision,revision,occurrence_count,first_occurred_at,latest_occurred_at)
       values($1,$2,'limit_approaching',$2,'active',true,'active',nextval('app.workspace_inbox_revision_seq'),1,clock_timestamp()-interval '100 days',clock_timestamp()-interval '100 days')`,
      [workspaceId, id],
    );
    await enforceUntilIdle();
    expect(
      (
        await admin.query(
          'select active,occurrence_count::text from app.workspace_inbox_threads where id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ active: true, occurrence_count: '1' }]);
  });

  it('does not delete a warning reactivated while its retention delete waits', async () => {
    const id = randomUUID();
    await admin.query(
      `insert into app.workspace_inbox_threads
        (workspace_id,id,notice_kind,subject_id,capacity_limit,active,source_revision,revision,occurrence_count,first_occurred_at,latest_occurred_at)
       values($1,$2,'limit_approaching',$2,'artifact_bytes',false,'artifact_bytes',nextval('app.workspace_inbox_revision_seq'),1,clock_timestamp()-interval '40 days',clock_timestamp()-interval '40 days')`,
      [workspaceId, id],
    );
    const rule = RETENTION_RULES.find(
      (candidate) => candidate.name === 'workspace_inbox_threads',
    );
    if (rule === undefined || !('run' in rule))
      throw new Error('Missing inbox retention rule');
    const applicationName = `retention-warning-${randomUUID()}`;
    const blocker = new Client({ connectionString: withDatabase(adminUrl) });
    const cleanerPool = new Pool({
      connectionString: withApplicationName(maintenanceUrl, applicationName),
      max: 1,
    });
    await blocker.connect();
    const cleaner = await cleanerPool.connect();
    let outcome: Promise<unknown> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query(
        'update app.workspace_inbox_threads set active=true,latest_occurred_at=clock_timestamp() where id=$1',
        [id],
      );
      const pending = rule.run(cleaner, 1000);
      outcome = pending.catch((error: unknown) => error);
      await waitForPostgresLock(applicationName);
      await blocker.query('commit');
      expect(await pending).toBe(0);
      expect(
        (
          await admin.query(
            'select active from app.workspace_inbox_threads where id=$1',
            [id],
          )
        ).rows,
      ).toEqual([{ active: true }]);
    } finally {
      await blocker.query('rollback');
      await outcome;
      cleaner.release();
      await cleanerPool.end();
      await blocker.end();
    }
  });

  it('skips a rule another worker is running', async () => {
    const old = await insertRun({ completedDaysAgo: 40 });
    await insertExecutionDetail(old);
    const index = RETENTION_RULES.findIndex(
      ({ name }) => name === 'run_events',
    );
    const holder = new Client({ connectionString: withDatabase(adminUrl) });
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock($1, $2)', [
        1_934_781_128,
        index,
      ]);
      const pass = await retention.enforce();
      expect(pass.removed.run_events).toBe(0);
      expect(pass.removed.node_runs).toBeGreaterThan(0);
      expect(await count('run_events', old)).toBe(1);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
    await enforceUntilIdle();
    expect(await count('run_events', old)).toBe(0);
  });
});
