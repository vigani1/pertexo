import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect } from 'vitest';
import { z } from 'zod';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts/schemas/catalog';
import { connectionListResponseSchema } from '@pertexo/contracts/schemas/connections';
import {
  workflowCreateResponseSchema,
  workflowDraftResponseSchema,
  workflowPublishResponseSchema,
  type WorkflowGraphContract,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { workspaceResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import type { useBetterAuthRealApi } from './better-auth-real-api.integration.support.js';

type Api = ReturnType<typeof useBetterAuthRealApi>;
export const workflowPortabilityBrowserEvidenceSchema = z.strictObject({
  sourceWorkspaceId: z.uuid(),
  destinationWorkspaceId: z.uuid(),
  sourceWorkflowId: z.uuid(),
  coreWorkflowId: z.uuid(),
  slotImportedWorkflowId: z.uuid(),
  coreImportedWorkflowId: z.uuid(),
  coreImportedVersionId: z.uuid(),
  coreImportedRunId: z.uuid(),
});

/** Ordinary authenticated authoring plus fixture-only opaque connection envelopes.
 * Encryption reads and provider calls remain prohibited by the owner runtime.
 */
export async function prepareWorkflowPortabilityBrowserFixture(
  api: Api,
  webOrigin: string,
) {
  const email = `portability-${randomUUID()}@integration.test`;
  await api.signUp(email, '/workspaces');
  const browser = await api.signIn(email);
  async function workspace(name: string) {
    const response = await api.send('POST', '/v1/workspaces', {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: { name, slug: `portable-${randomUUID().slice(0, 8)}` },
    });
    expect(response.statusCode, response.payload).toBe(201);
    return workspaceResponseSchema.parse(response.json()).id;
  }
  const sourceWorkspaceId = await workspace('Portable source workspace');
  const destinationWorkspaceId = await workspace(
    'Portable destination workspace',
  );
  const actor = await api
    .database()
    .query<{ id: string }>(
      "select id from app.users where email=$1 and status='active' and email_verified",
      [email],
    );
  const actorId = actor.rows[0]?.id;
  if (actorId === undefined)
    throw new Error('Verified portability fixture actor missing');
  const sourceConnectionId = randomUUID();
  const destinationConnectionId = randomUUID();
  const client = await api.database().connect();
  try {
    await client.query('begin');
    for (const [workspaceId, id, name] of [
      [sourceWorkspaceId, sourceConnectionId, 'Source-only HTTP account'],
      [
        destinationWorkspaceId,
        destinationConnectionId,
        'Explicit destination HTTP account',
      ],
    ]) {
      const secretId = randomUUID();
      await client.query(
        `insert into app.connections (id,workspace_id,provider_key,name,auth_type,status,current_secret_version_id,created_by) values ($1,$2,'http',$3,'http_headers','active',$4,$5)`,
        [id, workspaceId, name, secretId, actorId],
      );
      await client.query(
        `insert into app.connection_secret_versions (id,workspace_id,connection_id,schema_version,kms_key_reference,encrypted_data_key,ciphertext,nonce,auth_tag,created_by) values ($1,$2,$3,1,'fixture-not-decryptable','AQ','AQ','AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAA',$4)`,
        [secretId, workspaceId, id, actorId],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  const destinationConnections = await api.send(
    'GET',
    `/v1/workspaces/${destinationWorkspaceId}/connections?limit=100`,
    { browser },
  );
  expect(destinationConnections.statusCode).toBe(200);
  expect(
    connectionListResponseSchema.parse(destinationConnections.json()).items,
  ).toContainEqual(
    expect.objectContaining({
      id: destinationConnectionId,
      name: 'Explicit destination HTTP account',
      providerKey: 'http',
      authType: 'http_headers',
      status: 'active',
    }),
  );
  const catalogResponse = await api.send('GET', '/v1/node-definitions', {
    browser,
  });
  expect(catalogResponse.statusCode, catalogResponse.payload).toBe(200);
  const catalog = nodeDefinitionListResponseSchema.parse(
    catalogResponse.json(),
  );
  function node(key: string): WorkflowGraphContract['nodes'][number] {
    const definition = catalog.items.find(
      (item) =>
        item.definition.key === key && item.available && item.publishable,
    );
    if (definition === undefined)
      throw new Error('Portable browser fixture definition unavailable');
    return {
      id: randomUUID(),
      definition: definition.definition,
      configVersion: definition.configVersion,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      position: { x: 0, y: 0 },
    };
  }
  const core = {
    ...node('core.set'),
    inputMappings: { value: { kind: 'run_input' as const, path: '$.value' } },
  };
  const disabledHttp = {
    ...node('http.request'),
    disabled: true,
    position: { x: 260, y: 0 },
    config: {
      method: 'GET',
      url: 'https://example.test/never-dispatched',
      headers: {},
      timeoutMillis: 1000,
      maxRedirects: 0,
      maxResponseBytes: 1024,
      inlineResponseBytes: 1024,
    },
    connectionRefs: { http_headers: sourceConnectionId },
  };
  async function workflow(name: string, nodes: WorkflowGraphContract['nodes']) {
    const base = `/v1/workspaces/${sourceWorkspaceId}/workflows`;
    const created = await api.send('POST', base, {
      browser,
      headers: { 'Idempotency-Key': randomUUID() },
      payload: { name },
    });
    expect(created.statusCode, created.payload).toBe(201);
    const id = workflowCreateResponseSchema.parse(created.json()).workflow.id;
    const tag = String(created.headers.etag);
    const saved = await api.send('PUT', `${base}/${id}/draft`, {
      browser,
      headers: { 'If-Match': tag },
      payload: { graph: { schemaVersion: 1, nodes, edges: [], settings: {} } },
    });
    expect(saved.statusCode, saved.payload).toBe(200);
    workflowDraftResponseSchema.parse(saved.json());
    const published = await api.send('POST', `${base}/${id}/publish`, {
      browser,
      headers: {
        'If-Match': String(saved.headers.etag),
        'Idempotency-Key': randomUUID(),
      },
    });
    expect(published.statusCode, published.payload).toBe(200);
    return {
      id,
      versionId: workflowPublishResponseSchema.parse(published.json()).version
        .id,
    };
  }
  const slotSource = await workflow('Slot-bound portable source', [
    core,
    disabledHttp,
  ]);
  const coreSource = await workflow('Core-only portable source', [core]);
  const cookies = browser.cookie.split(';').map((part) => {
    const index = part.indexOf('=');
    return {
      name: part.slice(0, index).trim(),
      value: part.slice(index + 1).trim(),
      url: webOrigin,
    };
  });
  const scope = {
    sourceWorkspaceId,
    destinationWorkspaceId,
    sourceWorkflowId: slotSource.id,
    coreWorkflowId: coreSource.id,
    versionId: slotSource.versionId,
    destinationConnectionId,
    cookies,
  };
  return {
    scope,
    async deny() {
      const client = await api.database().connect();
      try {
        await client.query('begin');
        await client.query(
          'select id from app.workspaces where id=$1 for update',
          [destinationWorkspaceId],
        );
        await client.query('select id from app.users where id=$1 for update', [
          actorId,
        ]);
        const result = await client.query(
          "update app.workspace_memberships set status='suspended' where workspace_id=$1 and user_id=$2 and status='active'",
          [destinationWorkspaceId, actorId],
        );
        expect(result.rowCount).toBe(1);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function verifyWorkflowPortabilityBrowserEvidence(
  database: Pool,
  expected: Awaited<
    ReturnType<typeof prepareWorkflowPortabilityBrowserFixture>
  >['scope'],
  evidence: z.infer<typeof workflowPortabilityBrowserEvidenceSchema>,
) {
  expect(evidence).toMatchObject({
    sourceWorkspaceId: expected.sourceWorkspaceId,
    destinationWorkspaceId: expected.destinationWorkspaceId,
    sourceWorkflowId: expected.sourceWorkflowId,
    coreWorkflowId: expected.coreWorkflowId,
  });
  const source = await database.query<{ graph_json: WorkflowGraphContract }>(
    'select graph_json from app.workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3',
    [expected.versionId, expected.sourceWorkspaceId, expected.sourceWorkflowId],
  );
  expect(source.rows).toHaveLength(1);
  const imported = await database.query<{
    graph_json: WorkflowGraphContract;
    revision: number;
  }>(
    'select graph_json,revision from app.workflow_drafts where workspace_id=$1 and workflow_id=$2',
    [expected.destinationWorkspaceId, evidence.slotImportedWorkflowId],
  );
  expect(imported.rows).toHaveLength(1);
  expect(imported.rows[0]?.revision).toBeGreaterThan(1);
  const sourceGraph = workflowDraftResponseSchema.shape.graph.parse(
    source.rows[0]?.graph_json,
  );
  const importedGraph = workflowDraftResponseSchema.shape.graph.parse(
    imported.rows[0]?.graph_json,
  );
  expect(importedGraph.nodes.map((node) => node.id)).toEqual(
    sourceGraph.nodes.map((node) => node.id),
  );
  expect(
    importedGraph.nodes.find((node) => node.definition.key === 'http.request')
      ?.connectionRefs,
  ).toEqual({ http_headers: expected.destinationConnectionId });
  expect(importedGraph).not.toEqual(sourceGraph);
  const run = await database.query(
    'select workflow_id,workflow_version_id,status from app.workflow_runs where workspace_id=$1 and id=$2',
    [expected.destinationWorkspaceId, evidence.coreImportedRunId],
  );
  expect(run.rows).toEqual([
    {
      workflow_id: evidence.coreImportedWorkflowId,
      workflow_version_id: evidence.coreImportedVersionId,
      status: 'succeeded',
    },
  ]);
  const forbidden = await database.query(
    'select count(*)::int as count from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
    [expected.destinationWorkspaceId, evidence.slotImportedWorkflowId],
  );
  expect(forbidden.rows[0]).toEqual({ count: 0 });
}
