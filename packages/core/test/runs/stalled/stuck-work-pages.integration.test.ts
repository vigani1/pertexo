import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createOperatorCommandStore } from '../../../src/operator/operator-command.store.js';
import { claimDispatchAttempt } from '../run-store/node-attempts/fixture.js';
import { coordinatorConsumerName } from '../../../src/runs/advance/receipts.repository.js';
import { readStuckWork } from '../../../src/runs/stalled/stuck-work.repository.js';
import {
  asAdmin,
  databaseUrl,
  insertRun,
  parseDatabaseConfig,
  workspaceA,
} from '../run-store/fixtures.js';

type QueryPlanNode = Readonly<{
  'Relation Name'?: string;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  Plans?: readonly QueryPlanNode[];
}>;
const maintenance = new Pool({
  connectionString: databaseUrl(
    process.env.DATABASE_MAINTENANCE_URL ??
      'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo',
  ),
  max: 1,
});
const store = createOperatorCommandStore(
  parseDatabaseConfig({
    connectionString: databaseUrl(
      process.env.DATABASE_MAINTENANCE_URL ??
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo',
    ),
    max: 1,
  }),
);
afterAll(async () => {
  await store.close();
  await maintenance.end();
});
let busy = '',
  later = '';
beforeAll(async () => {
  busy = await insertRun({ status: 'running' });
  later = await insertRun({ status: 'waiting' });
  await asAdmin(async (client) => {
    // Confirmed delivery watches can outlive their work until the repair scan.
    await client.query(
      `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,published_at,delivery_due_at)
      select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',$2,'{}',repeat('a',64),clock_timestamp()-interval '1 day',
      '2026-01-01'::timestamptz+n*interval '1 microsecond' from generate_series(1,100000) n`,
      [workspaceA, busy],
    );
    await client.query(
      `insert into app.inbox_receipts(consumer_name,message_id,workspace_id,payload_checksum,completed_at)
      select $2,id,workspace_id,payload_checksum,clock_timestamp() from app.outbox_events where workspace_id=$1`,
      [workspaceA, coordinatorConsumerName],
    );
    await client.query(
      `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,available_at)
      select gen_random_uuid(),$1,'advance-workflow-run','workflow-run',case when n=301 then $3::uuid else $2::uuid end,'{}',repeat('a',64),
      '2026-01-02'::timestamptz+n*interval '1 microsecond' from generate_series(1,301) n`,
      [workspaceA, busy, later],
    );
    await client.query('analyze app.outbox_events');
    await client.query('analyze app.inbox_receipts');
  });
}, 60_000);

describe('bounded operator diagnostics', () => {
  it('continues past empty confirmed-history pages and a busy run to the other stuck run', async () => {
    let page = await store.listStuckWork();
    expect(page.runs.map((run) => run.runId)).toEqual([busy]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const seen = new Set(page.runs.map((run) => run.runId));
    // The unpublished lane advances independently of the 100,000 confirmed watches.
    for (let index = 0; index < 5 && page.nextCursor !== null; index++) {
      page = await store.listStuckWork(page.nextCursor);
      for (const run of page.runs) seen.add(run.runId);
    }
    expect(seen).toEqual(new Set([busy, later]));
    expect(page.runs).toEqual([]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.failedOutboxEvents).toEqual([]);
  });

  it('bounds the actual rows examined before diagnostics on a large confirmed history', async () => {
    const statements: { text: string; parameters: unknown[] }[] = [];
    const db = drizzle(maintenance, {
      logger: {
        logQuery(text, parameters) {
          statements.push({ text, parameters });
        },
      },
    });
    const page = await readStuckWork(db);
    expect(page.runs.map((run) => run.runId)).toContain(busy);
    let maximumOutboxScan = 0;
    for (const statement of statements) {
      const explained = await maintenance.query<{
        'QUERY PLAN': readonly { Plan: QueryPlanNode }[];
      }>(
        `explain (analyze,buffers,format json) ${statement.text}`,
        statement.parameters,
      );
      const root = explained.rows[0]?.['QUERY PLAN'][0];
      if (root === undefined) throw new Error('No query plan');
      const walk = (node: QueryPlanNode) => {
        if (node['Relation Name'] === 'outbox_events')
          maximumOutboxScan = Math.max(
            maximumOutboxScan,
            node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0),
          );
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(root.Plan);
    }
    console.info(
      JSON.stringify({
        confirmedHistory: 100000,
        statements: statements.length,
        maximumOutboxScan,
      }),
    );
    expect(maximumOutboxScan).toBeLessThanOrEqual(200);
  });
  it('eventually reaches an unconfirmed watch after confirmed history without losing microsecond positions', async () => {
    await asAdmin((client) =>
      client.query(
        `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,published_at,delivery_due_at)
      values(gen_random_uuid(),$1,'advance-workflow-run','workflow-run',$2,'{}',repeat('a',64),'2026-01-01','2026-01-01 00:00:00.100001Z')`,
        [workspaceA, later],
      ),
    );
    let page = await store.listStuckWork();
    let pages = 1;
    let found = false;
    while (page.nextCursor !== null && pages < 1600) {
      page = await store.listStuckWork(page.nextCursor);
      pages += 1;
      if (pages > 6 && page.runs.some((run) => run.runId === later))
        found = true;
    }
    expect(found).toBe(true);
    expect(page.nextCursor).toBeNull();
    expect(pages).toBeGreaterThan(1000);
  }, 60000);

  it('includes expired attempt ownership and continues all failed deliveries, at microsecond precision', async () => {
    const lease = await claimDispatchAttempt('diagnostic-lease', {
      sideEffectClass: 'safe',
    });
    const failedIds = await asAdmin(async (client) => {
      await client.query(
        `update app.node_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1`,
        [lease.attemptId],
      );
      return (
        await client.query<{ id: string }>(
          `insert into app.outbox_events(id,workspace_id,job_name,aggregate_type,aggregate_id,payload,payload_checksum,failed_at,last_error_code)
        select gen_random_uuid(),$1,'deliver-workspace-invitation','workspace-invitation',gen_random_uuid(),'{}',repeat('a',64),
        '2026-01-01'::timestamptz+n*interval '1 microsecond','publication.payload_invalid' from generate_series(1,201) n returning id`,
          [workspaceA],
        )
      ).rows.map((row) => row.id);
    });
    const first = await store.listStuckWork();
    expect(first.runs.map((run) => run.runId)).toContain(lease.runId);
    expect(first.failedOutboxEvents).toHaveLength(200);
    expect(
      first.failedOutboxEvents.every(
        (event) => event.lastErrorCode === 'publication.payload_invalid',
      ),
    ).toBe(true);
    const second = await store.listStuckWork(first.nextCursor ?? undefined);
    const events = [...first.failedOutboxEvents, ...second.failedOutboxEvents];
    expect(new Set(events.map((event) => event.outboxEventId))).toEqual(
      new Set(failedIds),
    );
    expect(events).toHaveLength(201);
    await expect(store.listStuckWork('not a cursor')).rejects.toThrow(
      'cursor is invalid',
    );
  });
});
