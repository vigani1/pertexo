import { Client, Pool, type QueryConfig } from 'pg';
import { expect, it } from 'vitest';
import { RETENTION_RULES } from '../../../src/lifecycle/retention/rules.js';
import {
  adminUrl,
  maintenanceUrl,
  randomUUID,
  retention,
  userId,
  withDatabase,
  workspaceId,
} from '../retention.support.js';
import { daysAgo, admin, enforceUntilIdle } from './fixture.js';

export function registerSkipsLockedExpiredAuditRows(): void {
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
}
