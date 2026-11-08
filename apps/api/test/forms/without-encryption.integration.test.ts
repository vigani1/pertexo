import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
} from '@pertexo/workflow-engine/server';
import { formConfigSchema, type WorkflowGraph } from '@pertexo/workflow-model';
import { createConnectionEnvelopeEncryption } from '@pertexo/secrets/server';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

const warnings: unknown[] = [];
const silent = () => undefined;
const api = useBetterAuthRealApi('forms_without_encryption', {
  logger: {
    debug: silent,
    info: silent,
    trace: silent,
    error: silent,
    fatal: silent,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  },
});
async function publishedForm() {
  const email = `${randomUUID()}@example.test`;
  await api.signUp(email, '/login?verified=true');
  const browser = await api.signIn(email);
  const actor = (
    await api
      .database()
      .query<{ id: string }>('select id from app.users where email=$1', [email])
  ).rows[0];
  if (actor === undefined) throw new Error('Owner missing');
  const created = await api.send('POST', '/v1/workspaces', {
    browser,
    headers: { 'idempotency-key': randomUUID() },
    payload: {
      name: 'Forms without encryption',
      slug: `form-${randomUUID().slice(0, 8)}`,
    },
  });
  expect(created.statusCode).toBe(201);
  const workspaceId = created.json<{ id: string }>().id;
  const workflowId = randomUUID(),
    versionId = randomUUID();
  const graph: WorkflowGraph = {
    settings: {},
    edges: [],
    nodes: [
      {
        id: 'form',
        definition: { key: 'core.form', version: 1 },
        configVersion: 1,
        config: formConfigSchema.parse({
          title: 'Contact',
          fields: [
            { id: 'name-field', name: 'name', label: 'Name', type: 'text' },
          ],
        }),
        position: { x: 0, y: 0 },
        inputMappings: {},
        connectionRefs: {},
      },
    ],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await api
    .database()
    .query(
      "insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Public form',$3)",
      [workflowId, workspaceId, actor.id],
    );
  await api
    .database()
    .query(
      'insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by) values($1,$2,$3,1,$4::json,$5,$6::json,$7)',
      [
        versionId,
        workspaceId,
        workflowId,
        JSON.stringify(graph),
        compiled.checksum,
        JSON.stringify(compiled.envelope),
        actor.id,
      ],
    );
  await api
    .database()
    .query('update app.workflows set published_version_id=$1 where id=$2', [
      versionId,
      workflowId,
    ]);
  return {
    browser,
    workspaceId,
    workflowId,
    versionId,
    path: `/v1/workspaces/${workspaceId}/workflows/${workflowId}/form/access`,
  };
}
async function submit(
  form: Awaited<ReturnType<typeof publishedForm>>,
  publicId: string,
  capability: string,
) {
  const response = await api.send('POST', `/v1/forms/${publicId}/submit`, {
    headers: {
      'x-pertexo-form-key': capability,
      'idempotency-key': randomUUID(),
    },
    payload: { versionId: form.versionId, values: { name: 'Ada' } },
  });
  expect(response.statusCode, response.payload).toBe(200);
  expect(response.json()).toMatchObject({ accepted: true });
}
describe.runIf(betterAuthIntegrationEnabled)(
  'forms without connection encryption',
  () => {
    it('issues the public link once, retains only its digest, and still admits public submissions', async () => {
      const form = await publishedForm();
      const capability = randomBytes(32).toString('base64url');
      const changed = await api.send('POST', form.path, {
        browser: form.browser,
        headers: { 'idempotency-key': randomUUID() },
        payload: { access: 'public', capability, expectedRevision: 0 },
      });
      expect(changed.statusCode, changed.payload).toBe(200);
      expect(changed.json()).toMatchObject({
        access: 'public',
        capability,
        revision: 1,
      });
      const publicId = changed.json<{ publicId: string }>().publicId;
      const read = await api.send('GET', form.path, { browser: form.browser });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toMatchObject({ capability: null, publicId });
      expect(
        (
          await api
            .database()
            .query(
              'select capability_hash,sealed_capability from app.workflow_forms where workflow_id=$1',
              [form.workflowId],
            )
        ).rows,
      ).toEqual([
        {
          capability_hash: createHash('sha256')
            .update(capability)
            .digest('hex'),
          sealed_capability: null,
        },
      ]);
      await submit(form, publicId, capability);
      const receipts = await api
        .database()
        .query(
          'select result_ref from app.idempotency_records where workspace_id=$1',
          [form.workspaceId],
        );
      expect(JSON.stringify(receipts.rows)).not.toContain(capability);
    });
    it('keeps a sealed link usable and warns the operator when its encryption runtime is unavailable', async () => {
      const form = await publishedForm();
      const publicId = randomUUID(),
        capability = randomBytes(32).toString('base64url');
      const encryption = createConnectionEnvelopeEncryption({
        mode: 'self-managed',
        encryption: {
          current: {
            version: 'fixture',
            key: Buffer.alloc(32, 24).toString('base64'),
          },
          previous: [],
        },
      });
      const sealed = await encryption.encryption.seal(Buffer.from(capability), {
        workspaceId: form.workspaceId,
        connectionId: form.workflowId,
        secretVersionId: form.workflowId,
      });
      encryption.close();
      await api
        .database()
        .query(
          "insert into app.workflow_forms(workspace_id,workflow_id,node_id,public_id,access,capability_hash,sealed_capability) values($1,$2,'form',$3,'public',$4,$5)",
          [
            form.workspaceId,
            form.workflowId,
            publicId,
            createHash('sha256').update(capability).digest('hex'),
            JSON.stringify(sealed),
          ],
        );
      warnings.length = 0;
      const read = await api.send('GET', form.path, { browser: form.browser });
      expect(read.statusCode, read.payload).toBe(200);
      expect(read.json()).toMatchObject({ capability: null, publicId });
      expect(JSON.stringify(warnings)).toContain(
        'Form capability encryption is unavailable',
      );
      expect(JSON.stringify(warnings)).not.toContain(capability);
      expect(
        (
          await api
            .database()
            .query(
              'select sealed_capability from app.workflow_forms where workflow_id=$1',
              [form.workflowId],
            )
        ).rows,
      ).toEqual([{ sealed_capability: sealed }]);
      await submit(form, publicId, capability);
    });
  },
);
