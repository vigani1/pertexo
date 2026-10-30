import { randomBytes, randomUUID } from 'node:crypto';

import {
  approvalConfigSchema,
  inputRequestConfigSchema,
} from '@pertexo/workflow-model';
import { expect } from 'vitest';

import type {
  Browser,
  useBetterAuthRealApi,
} from '../../support/better-auth/real-api.support.js';
import { emptyWorkflowGraph } from '../real-api/graphs.js';

export type Api = ReturnType<typeof useBetterAuthRealApi>;

/** One workspace holding something for every page to show. */
export type World = Readonly<{
  workspaceId: string;
  workflowId: string;
  versionId: string;
  draftTag: string;
  runId: string;
  connectionId: string;
  tableId: string;
  tagId: string;
  folderId: string;
  threadId: string;
  taskId: string;
  requestTaskId: string;
  formWorkflowId: string;
  formVersionId: string;
  formPublicId: string;
  formCapability: string;
  ownerEmail: string;
  viewerEmail: string;
}>;

export type WorkspaceStatus =
  'active' | 'suspended' | 'pending_deletion' | 'purging';

const formGraph = {
  settings: { maxRunDurationMs: 60_000 },
  nodes: [
    {
      id: 'form',
      definition: { key: 'core.form', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: {
        fields: [
          { id: 'note-field', name: 'note', label: 'Note', type: 'text' },
        ],
      },
      inputMappings: {},
      connectionRefs: {},
    },
    {
      id: 'finish',
      definition: { key: 'core.terminate', version: 1 },
      position: { x: 200, y: 0 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
    },
  ],
  edges: [
    {
      id: 'end',
      source: { nodeId: 'form', port: 'out' },
      target: { nodeId: 'finish', port: 'in' },
    },
  ],
};

export function apiHeaders(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { 'idempotency-key': randomUUID(), ...extra };
}

export async function seedWorld(api: Api): Promise<World> {
  const ownerEmail = `suspended-owner-${randomUUID()}@example.test`;
  const viewerEmail = `suspended-viewer-${randomUUID()}@example.test`;
  await api.signUp(ownerEmail, '/workspaces');
  await api.signUp(viewerEmail, '/workspaces');
  const owner = await api.signIn(ownerEmail);

  const workspace = await created(
    api.send('POST', '/v1/workspaces', {
      browser: owner,
      headers: apiHeaders(),
      payload: {
        name: 'Suspended browsing',
        slug: `suspended-${randomUUID().slice(0, 12)}`,
      },
    }),
  );
  const workspaceId = workspace.id;
  const root = `/v1/workspaces/${workspaceId}`;
  await api.database().query(
    `insert into app.workspace_memberships(workspace_id,user_id,role,status)
     select $1,id,'viewer','active' from app.users where email=$2`,
    [workspaceId, viewerEmail],
  );

  const workflow = await publishedWorkflow(api, {
    owner,
    root,
    name: 'Browsed',
  });
  const form = await publishedWorkflow(api, {
    owner,
    root,
    name: 'Form',
    graph: formGraph,
  });

  const { run } = await created<Readonly<{ run: Readonly<{ id: string }> }>>(
    api.send('POST', `${root}/workflows/${workflow.workflowId}/runs`, {
      browser: owner,
      headers: apiHeaders(),
      payload: { input: { note: 'browsed' } },
    }),
  );
  const runId = run.id;

  const connection = await created(
    api.send('POST', `${root}/connections`, {
      browser: owner,
      headers: apiHeaders(),
      payload: {
        providerKey: 'signing',
        name: 'Signing key',
        credential: { type: 'hmac_key', signingKey: 'fixture-demo-0042' },
      },
    }),
  );
  const table = await created(
    api.send('POST', `${root}/data-tables`, {
      browser: owner,
      headers: apiHeaders(),
      payload: {
        name: 'Orders',
        columns: [{ name: 'note', type: 'text', required: false }],
      },
    }),
  );

  const { tag } = await created<Readonly<{ tag: Readonly<{ id: string }> }>>(
    api.send('POST', `${root}/workflow-tags`, {
      browser: owner,
      headers: apiHeaders(),
      payload: { key: 'browsed' },
    }),
  );
  const folder = await created<Readonly<{ folder: Readonly<{ id: string }> }>>(
    api.send('POST', `${root}/workflow-folders`, {
      browser: owner,
      headers: apiHeaders(),
      payload: { name: 'Browsed', parentId: null },
    }),
  );
  const thread = await created<Readonly<{ threadId: string }>>(
    api.send('POST', `${root}/workflows/${workflow.workflowId}/comments`, {
      browser: owner,
      headers: apiHeaders(),
      payload: { body: 'Browsed', mentionUserIds: [] },
    }),
  );

  const formCapability = randomBytes(32).toString('base64url');
  const access = await api.send(
    'POST',
    `${root}/workflows/${form.workflowId}/form/access`,
    {
      browser: owner,
      headers: apiHeaders(),
      payload: {
        access: 'public',
        expectedRevision: 0,
        capability: formCapability,
      },
    },
  );
  expect(access.statusCode, access.payload).toBe(200);
  const formPublicId = access.json<{ publicId: string }>().publicId;

  const world = { workspaceId, runId, versionId: workflow.versionId };
  return {
    workspaceId,
    workflowId: workflow.workflowId,
    versionId: workflow.versionId,
    draftTag: workflow.draftTag,
    runId,
    connectionId: connection.id,
    tableId: table.id,
    tagId: tag.id,
    folderId: folder.folder.id,
    threadId: thread.threadId,
    taskId: await waitingHuman(api, world, 'approval'),
    requestTaskId: await waitingHuman(api, world, 'input_request'),
    formWorkflowId: form.workflowId,
    formVersionId: form.versionId,
    formPublicId,
    formCapability,
    ownerEmail,
    viewerEmail,
  };
}

/** Moves the workspace as a lifecycle command would; members sign in afresh. */
export async function setStatus(
  api: Api,
  workspaceId: string,
  status: WorkspaceStatus,
): Promise<void> {
  const deleting = status === 'pending_deletion' || status === 'purging';
  await api.database().query(
    `update app.workspaces set status=$2::text,
       deletion_requested_at=case when $3 then clock_timestamp() end,
       deletion_requested_by=case when $3 then created_by end,
       deletion_reason=case when $3 then 'suspended browsing proof' end,
       purge_after=case when $3 then clock_timestamp()+interval '7 days' end
     where id=$1`,
    [workspaceId, status, deleting],
  );
}

async function created<Body = Readonly<{ id: string }>>(
  reply: ReturnType<Api['send']>,
): Promise<Body> {
  const response = await reply;
  expect([200, 201, 202], response.payload).toContain(response.statusCode);
  return response.json<Body>();
}

async function publishedWorkflow(
  api: Api,
  {
    owner,
    root,
    name,
    graph = emptyWorkflowGraph(),
  }: Readonly<{ owner: Browser; root: string; name: string; graph?: object }>,
) {
  const base = `${root}/workflows`;
  const made = await api.send('POST', base, {
    browser: owner,
    headers: apiHeaders(),
    payload: { name },
  });
  expect(made.statusCode, made.payload).toBe(201);
  const workflowId = made.json<{ workflow: { id: string } }>().workflow.id;
  const saved = await api.send('PUT', `${base}/${workflowId}/draft`, {
    browser: owner,
    headers: apiHeaders({ 'if-match': String(made.headers.etag) }),
    payload: { graph },
  });
  expect(saved.statusCode, saved.payload).toBe(200);
  const draftTag = String(saved.headers.etag);
  const published = await api.send('POST', `${base}/${workflowId}/publish`, {
    browser: owner,
    headers: apiHeaders({ 'if-match': draftTag }),
  });
  expect(published.statusCode, published.payload).toBe(200);
  return {
    workflowId,
    draftTag,
    versionId: published.json<{ version: { id: string } }>().version.id,
  };
}

/** An engine-made row: no worker runs here to reach the human step. */
async function waitingHuman(
  api: Api,
  {
    workspaceId,
    runId,
    versionId,
  }: Pick<World, 'workspaceId' | 'runId' | 'versionId'>,
  kind: 'approval' | 'input_request',
): Promise<string> {
  const taskId = randomUUID();
  const nodeRunId = randomUUID();
  const invocationKey = `${versionId}|${kind}|b:|i:`;
  const config =
    kind === 'approval'
      ? approvalConfigSchema.parse({ allowStarterToDecide: true })
      : inputRequestConfigSchema.parse({});
  await api.database().query(
    `insert into app.node_runs(id,workspace_id,workflow_run_id,node_id,invocation_key,branch_context,status,side_effect_class,control_kind,resume_at)
     values($1,$2,$3,$4,$5,'{"branchPath":[],"iterationPath":[]}','waiting','safe','human_task',clock_timestamp()+interval '7 days')`,
    [nodeRunId, workspaceId, runId, kind, invocationKey],
  );
  await api.database().query(
    `insert into app.pending_run_tasks(id,workspace_id,run_id,workflow_version_id,node_run_id,invocation_key,kind,config,expires_at)
     values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp()+interval '7 days')`,
    [
      taskId,
      workspaceId,
      runId,
      versionId,
      nodeRunId,
      invocationKey,
      kind,
      JSON.stringify(config),
    ],
  );
  return taskId;
}
