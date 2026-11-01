import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import type { VariableUsagePage } from '../../src/variables/contract.js';

import { admin } from '../../../database/test/lifecycle/calls/fixtures.js';
import { userId } from '../../../database/test/lifecycle/retention.support.js';
import {
  afterAllFixture2,
  beforeAllFixture1,
  fixture,
  scope,
  store,
} from './configuration/fixture.js';

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
     values($1,$2,$3,$4,$5::jsonb,'{}'::jsonb,$6,$7)`,
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
  expect(pages[0]).toMatchObject({ checkedWorkflows: 2, totalWorkflows: 2 });
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
  expect(split[0]).toMatchObject({ checkedWorkflows: 0, totalWorkflows: 2 });
  expect(split.at(-1)).toMatchObject({
    checkedWorkflows: 2,
    totalWorkflows: 2,
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

it('counts a workflow only once it has been passed, however the pages were cut', async () => {
  const { workspaceId } = await twoWorkflows();
  // The first workflow holds three references, the second one.
  const pages = await everyPage(workspaceId, 'RATE', 1);
  expect(
    pages.map((page) => [page.checkedWorkflows, page.totalWorkflows]),
  ).toEqual([
    [0, 2],
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
});

it('reports nothing to check, as 0 of 0, for a workspace with no workflows at all', async () => {
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
    checkedWorkflows: 0,
    totalWorkflows: 0,
  });
});
