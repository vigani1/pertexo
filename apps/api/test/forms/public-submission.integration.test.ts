import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine/server';
import { formConfigSchema, type WorkflowGraph } from '@pertexo/workflow-model';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

const logs: unknown[] = [];
const capture = (...args: unknown[]) => {
  logs.push(args);
};
const api = useBetterAuthRealApi('public_forms', {
  logger: {
    debug: capture,
    error: capture,
    fatal: capture,
    info: capture,
    trace: capture,
    warn: capture,
  },
  connections: {
    config: {
      mode: 'self-managed',
      encryption: {
        current: {
          version: 'forms-test',
          key: Buffer.alloc(32, 21).toString('base64'),
        },
        previous: [],
      },
    },
  },
});
async function ownerWorkspace() {
  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  const browser = await api.signIn(email);
  const owner = (
    await api
      .database()
      .query<{ id: string }>('select id from app.users where email=$1', [email])
  ).rows[0];
  if (owner === undefined) throw new Error('Owner is missing');
  const created = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: 'Public form budget',
      slug: `form-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(created.statusCode).toBe(201);
  return {
    browser,
    actorId: owner.id,
    workspaceId: created.json<{ id: string }>().id,
  };
}
async function publicForm(scope: { actorId: string; workspaceId: string }) {
  const workflowId = randomUUID(),
    versionId = randomUUID(),
    publicId = randomUUID(),
    capability = randomBytes(32).toString('base64url');
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        id: 'form',
        definition: { key: 'core.form', version: 1 },
        configVersion: 1,
        config: formConfigSchema.parse({
          title: 'Contact',
          thankYouMessage: 'Got it',
          fields: [
            { id: 'name-field', name: 'name', label: 'Name', type: 'text' },
          ],
        }),
        position: { x: 0, y: 0 },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
    edges: [],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await api
    .database()
    .query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Public form',$3)",
      [workflowId, scope.workspaceId, scope.actorId],
    );
  await api.database().query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
    values($1,$2,$3,1,$4::json,$5,$6::json,$7)`,
    [
      versionId,
      scope.workspaceId,
      workflowId,
      JSON.stringify(graph),
      compiled.checksum,
      JSON.stringify(compiled.envelope),
      scope.actorId,
    ],
  );
  await api
    .database()
    .query('update app.workflows set published_version_id=$1 where id=$2', [
      versionId,
      workflowId,
    ]);
  await api.database().query(
    `insert into app.workflow_forms(workspace_id,workflow_id,node_id,access,public_id,capability_hash)
    values($1,$2,'form','public',$3,$4)`,
    [
      scope.workspaceId,
      workflowId,
      publicId,
      createHash('sha256').update(capability).digest('hex'),
    ],
  );
  return { workflowId, versionId, publicId, capability };
}
const send = (form: Awaited<ReturnType<typeof publicForm>>) =>
  api.send('POST', `/v1/forms/${form.publicId}/submit`, {
    headers: {
      'x-pertexo-form-key': form.capability,
      'idempotency-key': randomUUID(),
    },
    payload: { versionId: form.versionId, values: { name: 'Ada' } },
  });

describe.runIf(betterAuthIntegrationEnabled)(
  'public form HTTP admission',
  () => {
    it('retrieves sealed links only for workflow editors, keeps legacy links alive, and never records the capability in receipts or logs', async () => {
      const scope = await ownerWorkspace();
      const form = await publicForm(scope);
      const path = `/v1/workspaces/${scope.workspaceId}/workflows/${form.workflowId}/form/access`;
      const legacy = await api.send('GET', path, { browser: scope.browser });
      expect(legacy.statusCode, legacy.payload).toBe(200);
      expect(legacy.json()).toMatchObject({ capability: null });
      expect((await send(form)).statusCode).toBe(200);
      const capability = randomBytes(32).toString('base64url');
      const change = await api.send('POST', path, {
        browser: scope.browser,
        headers: { 'idempotency-key': 'retrievable' },
        payload: { access: 'public', capability, expectedRevision: 1 },
      });
      expect(change.statusCode, change.payload).toBe(200);
      expect(change.payload).not.toContain(capability);
      const stale = await api.send('POST', path, {
        browser: scope.browser,
        headers: { 'idempotency-key': 'stale' },
        payload: { access: 'public', capability, expectedRevision: 0 },
      });
      expect(stale.statusCode).toBe(409);
      const row = (
        await api
          .database()
          .query(
            'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
            [form.workflowId],
          )
      ).rows[0] as Record<string, unknown>;
      expect(row.sealed_capability).toMatchObject({
        ciphertext: expect.any(String) as unknown,
      });
      expect(JSON.stringify(row)).not.toContain(capability);
      for (const role of ['owner', 'admin', 'builder', 'operator', 'viewer']) {
        await api
          .database()
          .query(
            'update app.workspace_memberships set role=$1 where workspace_id=$2 and user_id=$3',
            [role, scope.workspaceId, scope.actorId],
          );
        const shown = await api.send('GET', path, { browser: scope.browser });
        if (['owner', 'admin', 'builder'].includes(role)) {
          expect(shown.statusCode, shown.payload).toBe(200);
          expect(shown.json()).toMatchObject({ capability });
        } else {
          expect(shown.statusCode).toBe(404);
          expect(shown.payload).not.toContain(capability);
        }
      }
      await api
        .database()
        .query(
          "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
          [scope.workspaceId, scope.actorId],
        );
      const folderId = randomUUID();
      await api
        .database()
        .query(
          "insert into app.workflow_folders(workspace_id,id,name,name_key,access_mode) values($1,$2,'Restricted','restricted','restricted')",
          [scope.workspaceId, folderId],
        );
      await api
        .database()
        .query(
          'insert into app.workflow_organization_state(workspace_id,workflow_id,folder_id) values($1,$2,$3) on conflict(workspace_id,workflow_id) do update set folder_id=excluded.folder_id',
          [scope.workspaceId, form.workflowId, folderId],
        );
      await api
        .database()
        .query(
          "insert into app.workflow_folder_grants(id,workspace_id,folder_id,user_id,access) values($1,$2,$3,$4,'viewer')",
          [randomUUID(), scope.workspaceId, folderId, scope.actorId],
        );
      await api
        .database()
        .query(
          "update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2",
          [scope.workspaceId, scope.actorId],
        );
      const restricted = await api.send('GET', path, {
        browser: scope.browser,
      });
      expect(restricted.statusCode, restricted.payload).toBe(200);
      expect(restricted.json()).toMatchObject({ capability: null });
      expect(restricted.payload).not.toContain(capability);
      await api
        .database()
        .query(
          "update app.workflow_folder_grants set access='editor' where folder_id=$1",
          [folderId],
        );
      const editable = await api.send('GET', path, { browser: scope.browser });
      expect(editable.statusCode, editable.payload).toBe(200);
      expect(editable.json()).toMatchObject({ capability });
      await api
        .database()
        .query(
          "update app.workspace_memberships set role='owner' where workspace_id=$1 and user_id=$2",
          [scope.workspaceId, scope.actorId],
        );
      const receipts = await api
        .database()
        .query(
          'select to_jsonb(receipt) as value from app.idempotency_records receipt where workspace_id=$1',
          [scope.workspaceId],
        );
      expect(JSON.stringify(receipts.rows)).not.toContain(capability);
      expect(JSON.stringify(logs)).not.toContain(capability);
      expect((await send(form)).statusCode).toBe(404);
      const current = await api.send('GET', path, { browser: scope.browser });
      const revoked = await api.send('POST', path, {
        browser: scope.browser,
        headers: { 'idempotency-key': 'revoke' },
        payload: {
          access: 'members',
          expectedRevision: current.json<{ revision: number }>().revision,
        },
      });
      expect(revoked.statusCode, revoked.payload).toBe(200);
      expect(
        (
          await api
            .database()
            .query(
              'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
              [form.workflowId],
            )
        ).rows,
      ).toEqual([{ capability_hash: null, sealed_capability: null }]);
    }, 30_000);
    it('enforces the shared workspace budget across forms without exposing run identity or admitting the refused response', async () => {
      const scope = await ownerWorkspace();
      const forms = await Promise.all(
        Array.from({ length: 3 }, () => publicForm(scope)),
      );
      for (let submission = 0; submission < 60; submission++) {
        const form = forms[submission % forms.length];
        if (form === undefined) throw new Error('Public form missing');
        const response = await send(form);
        expect(response.statusCode, response.payload).toBe(200);
        expect(response.json()).toEqual({
          accepted: true,
          thankYouMessage: 'Got it',
          replayed: false,
        });
      }
      const form = forms[0];
      if (form === undefined) throw new Error('Public form missing');
      const limited = await send(form);
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(
        (
          await api
            .database()
            .query(
              'select trigger_type,count(*)::int count from app.workflow_runs where workspace_id=$1 group by trigger_type',
              [scope.workspaceId],
            )
        ).rows,
      ).toEqual([{ trigger_type: 'form', count: 60 }]);
      expect(JSON.stringify(limited.json())).not.toContain(scope.workspaceId);
      const other = await publicForm(await ownerWorkspace());
      expect((await send(other)).statusCode).toBe(200);
    }, 30_000);
  },
);
