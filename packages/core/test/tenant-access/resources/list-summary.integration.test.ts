import { Pool } from 'pg';
import { adminDatabaseUrl } from '../../support/workflow-authoring/base.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  builder,
  viewer,
  publicId,
  publicRun,
  organization,
} from './folders/fixture.js';
import {
  authoring,
  actorId,
  emptyGraph,
  draftNode,
  randomUUID,
  queryAsOwner,
  workspaceId,
  otherWorkspaceId,
} from '../../support/workflow-authoring.js';

beforeAll(beforeAllFixture1, 30_000);
afterAll(afterAllFixture2);

it.each([() => builder, () => viewer])(
  'returns only readable topology and runs in both list projections',
  async (actor) => {
    const input = { workspaceId, actorId: actor(), limit: 50 };
    const page = await authoring.listWorkflows(input);
    expect(page.items.map((item) => item.id)).toEqual([publicId]);
    expect(page.items[0]?.listSummary).toMatchObject({
      shape: { nodes: [], edges: [] },
      recentRuns: [{ status: 'succeeded' }],
    });
    const organized = await organization.listWorkflows(input);
    expect(organized.items.map((item) => item.workflow.id)).toEqual([publicId]);
    expect(organized.items[0]?.workflow.listSummary).toEqual(
      page.items[0]?.listSummary,
    );
    await expect(
      authoring.listWorkflows({ ...input, workspaceId: otherWorkspaceId }),
    ).rejects.toThrow();
  },
);

it('bounds recent ordinary statuses to the latest 20 runs per workflow', async () => {
  await queryAsOwner(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,created_at,input_ref,input_ref_expires_at)
    select gen_random_uuid(),workspace_id,workflow_id,workflow_version_id,'manual','succeeded',clock_timestamp()+i*interval '1 second',input_ref,input_ref_expires_at
    from app.workflow_runs cross join generate_series(1,25) i where id=$1`,
    [publicRun],
    workspaceId,
  );
  const page = await authoring.listWorkflows({
    workspaceId,
    actorId: viewer,
    limit: 50,
  });
  const recent = page.items.find((item) => item.id === publicId)?.listSummary
    ?.recentRuns;
  expect(recent).toHaveLength(20);
  expect(recent?.every((run) => run.status === 'succeeded')).toBe(true);
  expect(recent?.map((run) => run.createdAt)).toEqual(
    recent
      ?.map((run) => run.createdAt)
      .sort()
      .reverse(),
  );
});

it('returns topology without configuration, mappings or connection references', async () => {
  const created = await authoring.createWorkflow({
    workspaceId,
    actorId,
    name: 'Topology only',
    idempotencyKey: randomUUID(),
    emptyGraph: {
      ...emptyGraph,
      nodes: [draftNode('step', { privateValue: 'must-stay-out' })],
    },
  });
  const page = await authoring.listWorkflows({
    workspaceId,
    actorId: viewer,
    limit: 50,
  });
  const summary = page.items.find(
    (item) => item.id === created.workflowId,
  )?.listSummary;
  expect(summary?.shape.nodes).toHaveLength(1);
  expect(summary?.shape.nodes[0]).toEqual({
    id: 'step',
    definition: { key: 'test.placeholder', version: 1 },
    position: { x: 0, y: 0 },
  });
  expect(JSON.stringify(summary)).not.toContain('must-stay-out');
});

it('uses one summary query at 50 and 500 workflows', async () => {
  await queryAsOwner(
    `with created as (
    insert into app.workflows(id,workspace_id,name,created_by)
    select gen_random_uuid(),$1,'Summary scale '||i,$2 from generate_series(1,499) i returning id
  ) insert into app.workflow_drafts(workspace_id,workflow_id,revision,graph_json,updated_by)
  select $1,id,1,$3::json,$2 from created`,
    [workspaceId, actorId, JSON.stringify(emptyGraph)],
    workspaceId,
  );
  const inspector = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  try {
    await inspector.query('create extension if not exists pg_stat_statements');
    const calls = async () => {
      const result = await inspector.query<{
        count: string;
      }>(`select coalesce(sum(calls),0)::text count
        from public.pg_stat_statements where dbid=(select oid from pg_database where datname=current_database())
        and query ilike '%json_agg(recent)%' and query not ilike '%pg_stat_statements%'`);
      return Number(result.rows[0]?.count);
    };
    for (const limit of [50, 500]) {
      const before = await calls();
      const page = await authoring.listWorkflows({
        workspaceId,
        actorId: viewer,
        limit,
      });
      expect(page.items).toHaveLength(limit);
      expect(page.items.every((item) => item.listSummary !== undefined)).toBe(
        true,
      );
      const queries = (await calls()) - before;
      expect(queries).toBe(1);
      console.info(
        JSON.stringify({ workflows: limit, summaryQueries: queries }),
      );
    }
  } finally {
    await inspector.end();
  }
});
