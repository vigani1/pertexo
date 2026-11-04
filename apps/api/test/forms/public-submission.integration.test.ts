import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine';
import { formConfigSchema, type WorkflowGraph } from '@pertexo/workflow-model';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

const api = useBetterAuthRealApi('public_forms');
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
  return { actorId: owner.id, workspaceId: created.json<{ id: string }>().id };
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
    values($1,$2,$3,1,$4,$5,$6,$7)`,
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
  return { versionId, publicId, capability };
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
