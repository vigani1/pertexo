import { randomUUID } from 'node:crypto';

import { createWorkspaceVariablesStore } from '@pertexo/core/variables';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resourceFailure } from '../../src/problems/context/normalize.js';
import { WorkspaceVariablesService } from '../../src/workspace-variables/service.js';
import { assertIntegrationGateConfigured } from '../support/integration-gate.js';
import { problemResult } from '../support/problem.js';

const requested = process.env.API_IDENTITY_INTEGRATION === 'true';
const databaseUrl = process.env.DATABASE_URL;
const adminUrl = process.env.DATABASE_ADMIN_URL;
assertIntegrationGateConfigured({
  name: 'workspace variables integration',
  requested,
  required: { DATABASE_URL: databaseUrl, DATABASE_ADMIN_URL: adminUrl },
});

describe.runIf(requested)('workspace variables over the real store', () => {
  let admin: Client;
  let store: ReturnType<typeof createWorkspaceVariablesStore>;
  let service: WorkspaceVariablesService;

  beforeAll(async () => {
    const adminDatabase = new URL(adminUrl ?? '');
    adminDatabase.pathname = new URL(databaseUrl ?? '').pathname;
    admin = new Client({ connectionString: adminDatabase.toString() });
    await admin.connect();
    store = createWorkspaceVariablesStore(
      parseDatabaseConfig({ connectionString: databaseUrl ?? '', max: 2 }),
    );
    service = new WorkspaceVariablesService(store);
  });
  afterAll(async () => {
    await store.close();
    await admin.end();
  });

  async function user() {
    const id = randomUUID();
    await admin.query(
      "insert into app.users(id,email,display_name) values($1,$2,'Variables owner')",
      [id, `${id}@example.test`],
    );
    return id;
  }

  async function workspace() {
    const actorId = await user();
    const workspaceId = randomUUID();
    await admin.query(
      "insert into app.workspaces(id,name,slug,created_by) values($1,'Variables',$2,$3)",
      [workspaceId, `variables-${workspaceId}`, actorId],
    );
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'owner','active')",
      [workspaceId, actorId],
    );
    return { workspaceId, actorId };
  }

  /** A draft with more sources than one page parses; its last input reads RATE. */
  async function workflowOverOnePage(
    scope: Awaited<ReturnType<typeof workspace>>,
  ) {
    const workflowId = randomUUID();
    await admin.query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Long',$3)",
      [workflowId, scope.workspaceId, scope.actorId],
    );
    const inputMappings = {
      ...Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `N${String(index).padStart(3, '0')}`,
          {
            kind: 'expression',
            language: 'jsonata',
            expression: '"unrelated"',
          },
        ]),
      ),
      last: { kind: 'workspace_variable', name: 'RATE' },
    };
    await admin.query(
      'insert into app.workflow_drafts(workspace_id,workflow_id,graph_json,updated_by) values($1,$2,$3::jsonb,$4)',
      [
        scope.workspaceId,
        workflowId,
        JSON.stringify({
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
        }),
        scope.actorId,
      ],
    );
    return workflowId;
  }

  async function continuation(scope: Awaited<ReturnType<typeof workspace>>) {
    const page = await service.usage({ ...scope, name: 'RATE', limit: 25 });
    expect(page.items).toEqual([]);
    if (page.nextCursor === null) throw new Error('Expected a continuation');
    return page.nextCursor;
  }

  const usageProblem = (
    scope: Awaited<ReturnType<typeof workspace>>,
    after: string,
  ) =>
    problemResult(
      Promise.resolve().then(() =>
        service.usage({ ...scope, name: 'RATE', limit: 25, after }),
      ),
      resourceFailure,
    );

  it('answers a stale save with a typed conflict and keeps the set', async () => {
    const scope = await workspace();
    const save = (expectedRevision: number, value: number) =>
      service.replace({
        ...scope,
        expectedRevision,
        values: { RATE: value },
        idempotencyKey: randomUUID(),
      });
    expect(await save(0, 1)).toEqual({
      revision: 1,
      changed: true,
      replayed: false,
    });
    await expect(
      problemResult(save(0, 2), resourceFailure),
    ).rejects.toMatchObject({ code: 'variables.changed' });
    expect(await service.read(scope)).toEqual({
      revision: 1,
      values: { RATE: 1 },
      descriptions: {},
    });
  });

  it('hides a workspace from someone without access, for every action', async () => {
    const scope = await workspace();
    const outsider = { ...scope, actorId: await user() };
    const actions: readonly (() => Promise<unknown>)[] = [
      () => service.read(outsider),
      () => service.usage({ ...outsider, name: 'RATE', limit: 25 }),
      () =>
        service.replace({
          ...outsider,
          expectedRevision: 0,
          values: { RATE: 1 },
          idempotencyKey: randomUUID(),
        }),
    ];
    for (const action of actions)
      await expect(
        problemResult(action(), resourceFailure),
      ).rejects.toMatchObject({ code: 'resource.not_found' });
  });

  it('continues a reference check through a page that found nothing', async () => {
    const scope = await workspace();
    const workflowId = await workflowOverOnePage(scope);
    const after = await continuation(scope);
    const page = await service.usage({
      ...scope,
      name: 'RATE',
      limit: 25,
      after,
    });
    expect(page.items.map((item) => [item.workflowId, item.input])).toEqual([
      [workflowId, 'last'],
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('asks for a restart when the workflow changed between pages', async () => {
    const scope = await workspace();
    const workflowId = await workflowOverOnePage(scope);
    const after = await continuation(scope);
    await admin.query(
      'update app.workflow_drafts set revision=revision+1 where workflow_id=$1',
      [workflowId],
    );
    await expect(usageProblem(scope, after)).rejects.toMatchObject({
      code: 'variables.usage_changed',
    });
  });

  describe('a continuation issued before pages spanned workflows', () => {
    // Written out, not worked out: an open tab's cursor outlives a deploy. This
    // digest means draft revision 1 with nothing published.
    const OLD_STAMP =
      '28f6766b5fb80e872afcf27841930088024e6e9fd95a0a0d8df076b911376978';
    const oldCursor = (workflowId: string, offset: number) =>
      Buffer.from(
        `{"workflowId":"${workflowId}","offset":${String(offset)},"stamp":"${OLD_STAMP}"}`,
      ).toString('base64url');

    it('resumes inside a workflow, above offset 0', async () => {
      const scope = await workspace();
      const workflowId = await workflowOverOnePage(scope);
      const page = await service.usage({
        ...scope,
        name: 'RATE',
        limit: 25,
        after: oldCursor(workflowId, 100),
      });
      expect(page.items.map((item) => [item.workflowId, item.input])).toEqual([
        [workflowId, 'last'],
      ]);
      expect(page.nextCursor).toBeNull();
    });

    it('passes the workflow it names, at offset 0', async () => {
      const scope = await workspace();
      const [first, second] = [
        await workflowOverOnePage(scope),
        await workflowOverOnePage(scope),
      ].sort();
      if (first === undefined || second === undefined)
        throw new Error('Workflows missing');
      const page = await service.usage({
        ...scope,
        name: 'RATE',
        limit: 25,
        after: oldCursor(first, 0),
      });
      expect(page.items).toEqual([]);
      if (page.nextCursor === null) throw new Error('Expected a continuation');
      const next = await service.usage({
        ...scope,
        name: 'RATE',
        limit: 25,
        after: page.nextCursor,
      });
      expect(next.items.map((item) => item.workflowId)).toEqual([second]);
    });

    it('is refused above offset 0 when its workflow has moved on', async () => {
      const scope = await workspace();
      const workflowId = await workflowOverOnePage(scope);
      await admin.query(
        'update app.workflow_drafts set revision=revision+1 where workflow_id=$1',
        [workflowId],
      );
      await expect(
        usageProblem(scope, oldCursor(workflowId, 100)),
      ).rejects.toMatchObject({ code: 'variables.usage_changed' });
    });
  });

  it('refuses a continuation that is not one it issued', async () => {
    const scope = await workspace();
    await expect(usageProblem(scope, 'e30')).rejects.toMatchObject({
      code: 'request.invalid',
    });
  });

  // api-11: continuations follow the shared opaque-cursor rule, which accepts
  // only the one canonical encoding of a cursor.
  it('refuses a continuation that is not canonically encoded', async () => {
    const scope = await workspace();
    await workflowOverOnePage(scope);
    const after = await continuation(scope);
    await expect(usageProblem(scope, `${after}=`)).rejects.toMatchObject({
      code: 'request.invalid',
    });
  });
});
