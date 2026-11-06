import { withTenantScopedClient } from '@pertexo/database/primitives';
import type { QueryConfig } from 'pg';
import { readVariableUsage } from '../../src/variables/usage.repository.js';
import { pool } from './variable-configuration.fixture.js';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { VariableUsagePage } from '../../src/variables/workspace-variables.js';

import { admin } from '../lifecycle/calls/calls.fixture.js';
import { userId } from '../lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  scope,
  store,
} from './variable-configuration.fixture.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);

const stepUsing = (inputMappings: Record<string, unknown>) => ({
  settings: {},
  edges: [],
  nodes: [
    {
      id: 'step',
      definition: { key: 'core.set', version: 1 },
      configVersion: 1,
      config: {},
      position: { x: 0, y: 0 },
      inputMappings,
      connectionRefs: {},
    },
  ],
});
const reads = (name: string) => ({ kind: 'workspace_variable', name });

async function setDraft(
  workspaceId: string,
  workflowId: string,
  graph: unknown,
) {
  await admin.query(
    'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
    [workspaceId, workflowId, JSON.stringify(graph), userId],
  );
}

async function addVersion(
  workspaceId: string,
  workflowId: string,
  versionNumber: number,
  graph: unknown,
) {
  const id = randomUUID();
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
     values($1,$2,$3,$4,$5::json,'{}'::jsonb,$6,$7)`,
    [
      id,
      workspaceId,
      workflowId,
      versionNumber,
      JSON.stringify(graph),
      `wf:sha256:${String(versionNumber).repeat(64)}`,
      userId,
    ],
  );
  return id;
}

/**
 * Two workflows, in id order. The first has a draft, a retired version naming
 * RETIRED and a current publication; the second has only a computed lookup.
 */
async function twoWorkflows() {
  const f = await fixture();
  const [first, second] = [f.parentWorkflowId, f.childWorkflowId].sort();
  if (first === undefined || second === undefined)
    throw new Error('Workflows missing');
  await setDraft(
    f.workspaceId,
    first,
    stepUsing({ draftOne: reads('RATE'), draftTwo: reads('RATE') }),
  );
  await addVersion(
    f.workspaceId,
    first,
    2,
    stepUsing({ fromRetired: reads('RETIRED') }),
  );
  const current = await addVersion(
    f.workspaceId,
    first,
    3,
    stepUsing({ fromCurrent: reads('RATE') }),
  );
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [first, current],
  );
  await setDraft(
    f.workspaceId,
    second,
    stepUsing({
      computed: {
        kind: 'expression',
        language: 'jsonata',
        expression: '$lookup($vars,runInput.name)',
      },
    }),
  );
  return { workspaceId: f.workspaceId, first, second };
}

async function everyPage(workspaceId: string, name: string, limit: number) {
  const pages: VariableUsagePage[] = [];
  let after: VariableUsagePage['next'] = null;
  // A cursor that fails to advance must fail this test, not hang it.
  for (let page = 0; page < 8; page += 1) {
    const current: VariableUsagePage = await store.usage({
      ...scope(workspaceId),
      name,
      limit,
      ...(after === null ? {} : { after }),
    });
    pages.push(current);
    if (current.next === null) return pages;
    after = current.next;
  }
  throw new Error('The reference check never finished');
}

it('checks every workflow once in a page, in draft then publication order', async () => {
  const { workspaceId, first, second } = await twoWorkflows();
  const pages = await everyPage(workspaceId, 'RATE', 25);
  expect(pages).toHaveLength(1);
  expect(pages[0]).toMatchObject({ next: null });
  expect(
    pages
      .flatMap((page) => page.items)
      .map(({ workflowId, stage, input, kind }) => ({
        workflowId,
        stage,
        input,
        kind,
      })),
  ).toEqual([
    { workflowId: first, stage: 'draft', input: 'draftOne', kind: 'direct' },
    { workflowId: first, stage: 'draft', input: 'draftTwo', kind: 'direct' },
    {
      workflowId: first,
      stage: 'published',
      input: 'fromCurrent',
      kind: 'direct',
    },
    { workflowId: second, stage: 'draft', input: 'computed', kind: 'dynamic' },
  ]);
});

it('reaches the same references when a small limit splits a workflow across pages', async () => {
  const { workspaceId } = await twoWorkflows();
  const items = (pages: readonly VariableUsagePage[]) =>
    pages.flatMap((page) => page.items).map((item) => item.id);
  const split = await everyPage(workspaceId, 'RATE', 1);
  expect(items(split)).toEqual(items(await everyPage(workspaceId, 'RATE', 25)));
  expect(split[0]?.next).toMatchObject({ offset: 1 });
  expect(split.at(-1)).toMatchObject({
    next: null,
  });
});

it('reports only a current publication, not a retired version', async () => {
  const { workspaceId, second } = await twoWorkflows();
  const pages = await everyPage(workspaceId, 'RETIRED', 25);
  expect(
    pages
      .flatMap((page) => page.items)
      .map(({ workflowId, kind }) => ({ workflowId, kind })),
  ).toEqual([{ workflowId: second, kind: 'dynamic' }]);
});

it('has nothing to report for a workspace without workflows that use the name', async () => {
  const f = await fixture();
  expect(
    await store.usage({ ...scope(f.workspaceId), name: 'RATE', limit: 25 }),
  ).toMatchObject({ items: [], incomplete: false });
});

it('reports cursor progress inside a workflow and completion at the end', async () => {
  const { workspaceId } = await twoWorkflows();
  const pages = await everyPage(workspaceId, 'RATE', 1);
  expect(pages.map((page) => page.next?.offset ?? null)).toEqual([
    1,
    2,
    0,
    null,
  ]);
});

it('reports completion with no references for a workspace with no workflows at all', async () => {
  const workspaceId = randomUUID();
  await admin.query(
    "insert into app.workspaces(id,name,slug,created_by) values($1,'Empty',$2,$3)",
    [workspaceId, `empty-${workspaceId}`, userId],
  );
  await admin.query(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
    [workspaceId, userId],
  );
  expect(
    await store.usage({ ...scope(workspaceId), name: 'RATE', limit: 25 }),
  ).toEqual({
    items: [],
    incomplete: false,
    next: null,
  });
});

it('bounds database work for an empty reference page independently of 10000 visible workflows', async () => {
  const { workspaceId } = await twoWorkflows();
  await admin.query(
    `insert into app.workflows(id,workspace_id,name,created_by) select gen_random_uuid(),$1,'Unrelated '||n,$2 from generate_series(1,10000)n`,
    [workspaceId, userId],
  );
  await admin.query('analyze app.workflows');
  const page = await withTenantScopedClient(
    pool,
    { workspaceId, actorId: userId },
    async (client) => {
      const captured: { text: string; values: unknown[] }[] = [];
      const traced = new Proxy(client, {
        get(target, key) {
          if (key !== 'query') return Reflect.get(target, key) as unknown;
          return (config: string | QueryConfig, values?: unknown[]) => {
            const text = typeof config === 'string' ? config : config.text;
            captured.push({
              text,
              values:
                values ??
                (typeof config === 'string' ? [] : (config.values ?? [])),
            });
            return target.query(config, values);
          };
        },
      });
      const result = await readVariableUsage(
        traced,
        { ...scope(workspaceId), name: 'UNUSED', limit: 1 },
        'owner',
      );
      interface Plan {
        'Actual Rows': number;
        'Actual Loops': number;
        Plans?: Plan[];
      }
      const visited = (plan: Plan): number =>
        plan['Actual Rows'] * plan['Actual Loops'] +
        (plan.Plans ?? []).reduce((sum, child) => sum + visited(child), 0);
      let work = 0;
      for (const statement of captured) {
        const explained = await client.query<{
          'QUERY PLAN': { Plan: Plan }[];
        }>(`explain (analyze,format json) ${statement.text}`, statement.values);
        const plan = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
        if (plan === undefined) throw new Error('Usage plan missing');
        work += visited(plan);
      }
      expect(work).toBeLessThan(2000);
      return result;
    },
  );
  expect(page.items).toEqual([]);
  expect(page.next).not.toBeNull();
  expect(page).not.toHaveProperty('totalWorkflows');
});
