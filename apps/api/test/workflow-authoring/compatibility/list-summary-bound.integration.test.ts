import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createWorkflowLifecycleApiFixture,
  closeWorkflowLifecycleApiFixture,
  workflowLifecycleIntegrationEnabled,
  type WorkflowLifecycleApiFixture,
} from '../lifecycle.support.js';

let fixture: WorkflowLifecycleApiFixture;
beforeAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    fixture = await createWorkflowLifecycleApiFixture();
});
afterAll(async () => {
  if (workflowLifecycleIntegrationEnabled)
    await closeWorkflowLifecycleApiFixture(fixture);
});

it.skipIf(!workflowLifecycleIntegrationEnabled)(
  'bounds list endpoint buffer work despite thousands of newer test runs',
  async () => {
    const session = await fixture.login('viewer');
    const adminUrl = new URL(process.env.DATABASE_ADMIN_URL ?? '');
    adminUrl.pathname = new URL(process.env.DATABASE_URL ?? '').pathname;
    const pool = new Pool({
      connectionString: adminUrl.toString(),
      max: 1,
    });
    try {
      await pool.query('create extension if not exists pg_stat_statements');
      const counters = async () => {
        const result = await pool.query<{ calls: string; blocks: string }>(
          `select coalesce(sum(calls),0)::text calls, coalesce(sum(shared_blks_hit+shared_blks_read),0)::text blocks from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and query ilike '%json_agg(recent)%' and query not ilike '%pg_stat_statements%'`,
        );
        return {
          calls: Number(result.rows[0]?.calls),
          blocks: Number(result.rows[0]?.blocks),
        };
      };
      const measure = async () => {
        const before = await counters();
        const response = await fixture.application.inject({
          method: 'GET',
          url: `/v1/workspaces/${fixture.workspaceId}/workflows?include=listSummary`,
          headers: { cookie: session.cookieHeader },
        });
        expect(response.statusCode, response.payload).toBe(200);
        const row = response
          .json<{
            items: {
              id: string;
              listSummary: { recentRuns: { status: string }[] };
            }[];
          }>()
          .items.find((item) => item.id === fixture.ids.published);
        expect(row?.listSummary.recentRuns.map((run) => run.status)).toEqual([
          'succeeded',
        ]);
        const after = await counters();
        expect(after.calls - before.calls).toBe(1);
        return after.blocks - before.blocks;
      };
      await measure();
      const ordinary = await measure();
      await fixture.withOwner((client) =>
        client.query(
          `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at) select gen_random_uuid(),$1,$2,$3,'test','failed',clock_timestamp()+i*interval '1 millisecond' from generate_series(1,5000) i`,
          [
            fixture.workspaceId,
            fixture.ids.published,
            fixture.ids.publishedVersion,
          ],
        ),
      );
      await pool.query('analyze app.workflow_runs');
      const heavy = await measure();
      console.info(
        JSON.stringify({ ordinaryBlocks: ordinary, testHeavyBlocks: heavy }),
      );
      // The same page and ordinary history need only a small index-depth allowance.
      expect(heavy).toBeLessThanOrEqual(ordinary + 40);
    } finally {
      await pool.end();
    }
  },
  120_000,
);

it.skipIf(!workflowLifecycleIntegrationEnabled)(
  'hides restricted workflow run summaries exactly as individual run reads do',
  async () => {
    await fixture.withOwner(async (client) => {
      const folder = await client.query<{ id: string }>(
        `insert into app.workflow_folders(id,workspace_id,name,name_key,access_mode) values(gen_random_uuid(),$1,'Hidden runs','hidden runs','restricted') returning id`,
        [fixture.workspaceId],
      );
      await client.query(
        `insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3)`,
        [fixture.workspaceId, fixture.ids.published, folder.rows[0]?.id],
      );
    });
    const session = await fixture.login('viewer');
    const get = (url: string) =>
      fixture.application.inject({
        method: 'GET',
        url,
        headers: { cookie: session.cookieHeader },
      });
    const base = `/v1/workspaces/${fixture.workspaceId}`;
    expect((await get(`${base}/runs/${fixture.ids.run}`)).statusCode).toBe(404);
    for (const include of ['listSummary', 'organization,listSummary']) {
      const response = await get(`${base}/workflows?include=${include}`);
      expect(response.statusCode, response.payload).toBe(200);
      expect(response.payload).not.toContain(fixture.ids.published);
      expect(response.payload).not.toContain('succeeded');
      expect(response.payload).toContain(fixture.ids.unpublished);
    }
  },
);
