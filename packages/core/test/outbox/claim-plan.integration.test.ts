import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTransportTestEnvironment } from './transport.support.js';
import { claimOutboxBatch } from '../../src/outbox/dispatcher/claim.js';

const transport = createTransportTestEnvironment();
beforeAll(transport.initialize);
afterAll(transport.close);

it('claims a fair bounded batch using the real indexed plan amid due, disabled and future work', async () => {
  const workspaces = [transport.workspaceA, transport.workspaceB];
  for (const workspaceId of workspaces)
    await transport.apiDatabase.withWorkspace(workspaceId, ({ db }) =>
      db.execute(sql`
    insert into app.outbox_events (id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at)
    select gen_random_uuid(),${workspaceId},case when n<=10000 then 'disabled-plan-proof' else 'enabled-plan-proof' end,
      'queue-proof',gen_random_uuid(),'{}'::jsonb,repeat('0',64),
      case when n>11000 then clock_timestamp()+interval '1 hour' else to_timestamp(0) end
    from generate_series(1,12000) n
  `),
    );
  const adminUrl = new URL(
    process.env.DATABASE_ADMIN_URL ??
      'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
  );
  adminUrl.pathname = new URL(transport.dispatcherUrl).pathname;
  const pool = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  const plans: string[] = [];
  try {
    const client = await pool.connect();
    try {
      client.on('notice', (notice) => {
        if (notice.message !== undefined) plans.push(notice.message);
      });
      await client.query('analyze app.outbox_events');
      await client.query("load 'auto_explain'");
      await client.query('set auto_explain.log_min_duration=0');
      await client.query('set auto_explain.log_analyze=on');
      await client.query('set auto_explain.log_buffers=on');
      await client.query('set auto_explain.log_level=notice');
      await client.query('set role pertexo_maintenance');
    } finally {
      client.release();
    }
    const started = performance.now();
    const result = await claimOutboxBatch(pool, {
      enabledJobNames: ['enabled-plan-proof'],
      leaseDurationMillis: 30_000,
      leaseOwner: 'actual-plan-proof',
      leaseToken: randomUUID(),
      limit: 20,
    });
    expect(result.events).toHaveLength(20);
    for (const workspaceId of workspaces)
      expect(
        result.events.filter((event) => event.workspaceId === workspaceId),
      ).toHaveLength(10);
    expect(
      result.events.every(
        (event) =>
          event.jobName === 'enabled-plan-proof' &&
          event.availableAt.getTime() === 0,
      ),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
    const claimPlans = plans.filter((plan) =>
      plan.includes('with cursor_state as materialized'),
    );
    expect(claimPlans).toHaveLength(1);
    expect(claimPlans[0]).toContain('outbox_events_dispatch_job_due_idx');
    expect(claimPlans[0]).toContain('Buffers:');
    expect(claimPlans[0]).toContain('actual time=');
  } finally {
    await pool.end();
  }
}, 30_000);
