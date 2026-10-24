import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { usageTrendsResponseSchema } from '@pertexo/contracts';
import { readUsageTrends } from '../../src/runs/queries/usage-trends.queries.js';
import { apiPool, apiUrl } from '../support/workflow-authoring.js';
import { withTenantScopedClient } from '../../src/tenant-access/transactions.js';
import {
  explainDocument,
  explainWork,
  indexScans,
} from '../support/postgres/query-plan.js';
import {
  seedNoticeWorkspace,
  seedNoticeWorkflow,
  queryAsOwner,
} from '../inbox/notices.fixture.js';

function queryText(request: unknown): string | undefined {
  if (typeof request === 'string') return request;
  if (request === null || typeof request !== 'object') return undefined;
  if (!('text' in request) || typeof request.text !== 'string')
    return undefined;
  return request.text;
}

async function add(
  workspaceId: string,
  workflowId: string,
  {
    status,
    age,
    seconds,
    test = false,
  }: Readonly<{
    status: string;
    age: string;
    seconds: number | null;
    test?: boolean | undefined;
  }>,
) {
  await withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    client.query(
      `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,updated_at,started_at,completed_at)
     values($1,$2,$3,$4,$5,$6,statement_timestamp()-$7::interval,statement_timestamp(),
       case when $8::double precision is not null then statement_timestamp()-$7::interval end,
       case when $8::double precision is not null then statement_timestamp()-$7::interval+make_interval(secs=>$8::double precision) end)`,
      [
        randomUUID(),
        workspaceId,
        workflowId,
        randomUUID(),
        test ? 'test' : 'manual',
        status,
        age,
        seconds,
      ],
    ),
  );
}
function read(
  workspace: Awaited<ReturnType<typeof seedNoticeWorkspace>>,
  period: '30d' | '90d' = '30d',
  includeWorkflowNames = true,
) {
  return readUsageTrends(apiPool, {
    workspaceId: workspace.workspaceId,
    actorId: workspace.members.owner,
    period,
    includeWorkflowNames,
  });
}

describe('retained usage trends', () => {
  it('returns 30/90 UTC days, zero outcomes and unavailable durations when empty', async () => {
    const f = await seedNoticeWorkspace();
    for (const period of ['30d', '90d'] as const) {
      const result = usageTrendsResponseSchema.parse(await read(f, period));
      expect(result.days).toHaveLength(period === '30d' ? 30 : 90);
      expect(result.from).toMatch(/T00:00:00\.000000Z$/u);
      expect(result.days.at(-1)?.day).toBe(result.asOf.slice(0, 10));
      expect(result).toMatchObject({
        total: 0,
        elapsed: { measuredRuns: 0, averageMs: null, slowestMs: null },
        busiest: [],
        mostFailures: [],
      });
    }
  });
  it('counts actual runs, excludes tests, weights elapsed durations and ranks distinct periods', async () => {
    const f = await seedNoticeWorkspace();
    const other = await seedNoticeWorkflow(f.workspaceId, f.members.owner);
    await add(f.workspaceId, f.workflowId, {
      status: 'succeeded',
      age: '1 hour',
      seconds: 20,
    });
    await add(f.workspaceId, f.workflowId, {
      status: 'failed',
      age: '2 hours',
      seconds: 40,
    });
    await add(f.workspaceId, f.workflowId, {
      status: 'queued',
      age: '3 hours',
      seconds: null,
    });
    await add(f.workspaceId, other, {
      status: 'outcome_unknown',
      age: '45 days',
      seconds: 80,
    });
    await add(f.workspaceId, other, {
      status: 'succeeded',
      age: '1 hour',
      seconds: 1000,
      test: true,
    });
    const recent = usageTrendsResponseSchema.parse(await read(f));
    expect(recent).toMatchObject({
      total: 3,
      byStatus: { succeeded: 1, failed: 1, queued: 1 },
      elapsed: { measuredRuns: 2, averageMs: 30000, slowestMs: 40000 },
      busiest: [{ workflowId: f.workflowId, runs: 3, failures: 1 }],
      mostFailures: [{ workflowId: f.workflowId, runs: 3, failures: 1 }],
    });
    const long = await read(f, '90d');
    expect(long).toMatchObject({
      total: 4,
      byStatus: { outcome_unknown: 1 },
      elapsed: { measuredRuns: 3, slowestMs: 80000 },
    });
    expect(long.elapsed.averageMs).toBeCloseTo(140000 / 3);
    expect(long.mostFailures).toHaveLength(2);
  });
  it('preserves tenant and name fences and survives expired execution details', async () => {
    const f = await seedNoticeWorkspace(),
      foreign = await seedNoticeWorkspace();
    await add(f.workspaceId, f.workflowId, {
      status: 'succeeded',
      age: '40 days',
      seconds: 10,
    });
    await add(foreign.workspaceId, foreign.workflowId, {
      status: 'failed',
      age: '1 hour',
      seconds: 10,
    });
    await queryAsOwner(
      'update app.workflow_runs set details_purged_at=statement_timestamp(),input_ref=null,output_ref=null,error_summary=null where workspace_id=$1',
      [f.workspaceId],
      f.workspaceId,
    );
    const hidden = await read(f, '90d', false);
    expect(hidden).toMatchObject({
      total: 1,
      busiest: [
        { workflowId: f.workflowId, workflowName: null, runs: 1, failures: 0 },
      ],
      mostFailures: [],
    });
    const named = await read(f, '90d');
    expect(named.busiest[0]?.workflowName).toBeTruthy();
    expect((await read(foreign)).total).toBe(1);
  });

  it('includes the exact first UTC midnight and excludes the instant before it and future runs', async () => {
    const f = await seedNoticeWorkspace();
    await withTenantScopedClient(
      apiPool,
      { workspaceId: f.workspaceId },
      (client) =>
        client.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at)
        select gen_random_uuid(),$1,$2,gen_random_uuid(),'manual','succeeded',
        (date_trunc('day',statement_timestamp() at time zone 'UTC')-interval '29 days') at time zone 'UTC'+offset_at
        from (values (interval '0 seconds'),(interval '-1 microsecond'),(interval '30 days')) offsets(offset_at)`,
          [f.workspaceId, f.workflowId],
        ),
    );
    const result = await read(f);
    expect(result.total).toBe(1);
    expect(result.days[0]).toMatchObject({
      day: result.from.slice(0, 10),
      total: 1,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readUsageTrends(apiPool, {
        workspaceId: f.workspaceId,
        actorId: f.members.owner,
        period: '30d',
        includeWorkflowNames: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('bounds rankings and indexed reads with retained, expired and foreign history', async () => {
    const f = await seedNoticeWorkspace(),
      foreign = await seedNoticeWorkspace();
    const workflows = [f.workflowId];
    for (let index = 1; index < 12; index++)
      workflows.push(await seedNoticeWorkflow(f.workspaceId, f.members.owner));
    // Only static terminal history is seeded here. Avoid the admission trigger's
    // per-row recount while preparing the isolated read-plan fixture.
    const fixtureUrl = new URL(
      process.env.DATABASE_ADMIN_URL ??
        'postgresql://postgres:pertexo-local-superuser@localhost:5432/postgres',
    );
    fixtureUrl.pathname = new URL(apiUrl).pathname;
    const fixtureAdmin = new Pool({
      connectionString: fixtureUrl.toString(),
      max: 1,
    });
    const seed = await fixtureAdmin.connect();
    try {
      await seed.query('begin');
      await seed.query(
        'alter table app.workflow_runs disable trigger workflow_runs_execution_admission',
      );
      await seed.query(
        'alter table app.workflow_runs disable trigger workflow_runs_refresh_execution_admission',
      );
      for (const [workspaceId, ids, count] of [
        [f.workspaceId, workflows, 16000],
        [foreign.workspaceId, [foreign.workflowId], 32000],
      ] as const) {
        await seed.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        await seed.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,execution_entitlement_version,admission_ticket,created_at,started_at,completed_at)
       select gen_random_uuid(),$1,($2::uuid[])[1+ordinal%array_length($2::uuid[],1)],gen_random_uuid(),'manual',
       (array['succeeded','failed','timed_out','outcome_unknown'])[1+ordinal%4],1,nextval('app.workflow_run_admission_ticket_seq'),
       statement_timestamp()-make_interval(hours=>ordinal%2880),statement_timestamp()-make_interval(hours=>ordinal%2880),statement_timestamp()-make_interval(hours=>ordinal%2880)+interval '1 second'
       from generate_series(1,$3::integer) ordinal`,
          [workspaceId, ids, count],
        );
      }
      await seed.query(
        'alter table app.workflow_runs enable trigger workflow_runs_refresh_execution_admission',
      );
      await seed.query(
        'alter table app.workflow_runs enable trigger workflow_runs_execution_admission',
      );
      await seed.query('analyze app.workflow_runs');
      await seed.query('commit');
    } catch (error: unknown) {
      await seed.query('rollback');
      throw error;
    } finally {
      seed.release();
      await fixtureAdmin.end();
    }
    const capture = vi.spyOn(Client.prototype, 'query');
    let statements: { text: string; values: unknown[] }[] = [];
    const started = performance.now();
    try {
      const result = await read(f, '90d');
      expect(result.total).toBeGreaterThan(10000);
      expect(result.total).toBeLessThan(16000);
      expect(result.busiest).toHaveLength(10);
      expect(result.mostFailures).toHaveLength(9);
      expect(result.busiest).toEqual(
        [...result.busiest].sort(
          (a, b) => b.runs - a.runs || a.workflowId.localeCompare(b.workflowId),
        ),
      );
      statements = capture.mock.calls.flatMap(([request, values]) => {
        const text = queryText(request);
        if (text === undefined || !Array.isArray(values)) return [];
        if (!text.replaceAll('"', '').startsWith('with window_runs')) return [];
        return [{ text, values }];
      });
    } finally {
      capture.mockRestore();
    }
    const elapsedMs = performance.now() - started;
    expect(statements).toHaveLength(2);
    const plans = [];
    for (const statement of statements) {
      const plan = explainDocument(
        await withTenantScopedClient(
          apiPool,
          { workspaceId: f.workspaceId },
          (client) =>
            client.query(
              `explain(analyze,buffers,settings,format json) ${statement.text}`,
              statement.values,
            ),
          { statementTimeoutMillis: 2000 },
        ),
      );
      expect(plan.Settings?.enable_seqscan).not.toBe('off');
      // Aggregate once, rather than revisiting the retained rows for every day.
      expect(explainWork(plan.Plan).summedNodeRowWork).toBeLessThan(66000);
      expect(
        indexScans(plan.Plan).some((scan) =>
          scan.index.startsWith('workflow_runs_workspace_'),
        ),
      ).toBe(true);
      plans.push({
        elapsedMs: plan['Execution Time'],
        buffers: explainWork(plan.Plan).rootSharedBufferTouches,
      });
    }
    console.info(
      'F12 trends qualification',
      JSON.stringify({ ownRows: 16000, foreignRows: 32000, elapsedMs, plans }),
    );
  }, 30000);
});
