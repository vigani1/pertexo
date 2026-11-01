import type { z } from 'zod';

import { randomUUID } from 'node:crypto';

import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import { formConfigSchema, type WorkflowGraph } from '@pertexo/workflow-model';
import { createFormStore } from '../../../../src/triggers/forms/repository.js';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import { admin, createFamily } from '../../../lifecycle/calls/fixtures.js';
import { apiUrl, userId } from '../../../lifecycle/retention.support.js';

export let store: ReturnType<typeof createFormStore>;

export async function submitForm(...args: Parameters<typeof store.submit>) {
  const result = await store.submit(...args);
  if (!result.accepted)
    throw new Error('Expected an accepted form in this journey');
  return result;
}

export async function fixture(config: z.input<typeof formConfigSchema> = {}) {
  const family = await createFamily({ childDays: 0, consumed: true });
  const workflowId = randomUUID(),
    versionId = randomUUID(),
    viewerId = randomUUID();
  await admin.query(
    `insert into app.users(id,email,display_name) values($1,$2,'Form responder')`,
    [viewerId, `${viewerId}@example.test`],
  );
  for (const [actor, role] of [
    [userId, 'owner'],
    [viewerId, 'viewer'],
  ])
    await admin.query(
      `insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')`,
      [family.workspaceId, actor, role],
    );
  const node = (id: string, key: string) => ({
    id,
    definition: { key, version: 1 },
    configVersion: 1,
    config: {},
    position: { x: 0, y: 0 },
    inputMappings: {},
    connectionRefs: {},
  });
  const graph: WorkflowGraph = {
    settings: {},
    nodes: [
      {
        ...node('form', 'core.form'),
        config: formConfigSchema.parse({
          fields: [
            {
              id: 'amount-field',
              name: 'amount',
              label: 'Amount',
              type: 'number',
            },
            {
              id: 'message-field',
              name: 'message',
              label: 'Message',
              type: 'text',
              required: false,
            },
          ],
          ...config,
        }),
      },
      node('finish', 'core.terminate'),
    ],
    edges: [
      {
        id: 'end',
        source: { nodeId: 'form', port: 'out' },
        target: { nodeId: 'finish', port: 'in' },
      },
    ],
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  await admin.query(
    `insert into app.workflows(id,workspace_id,name,created_by) values($1,$2,'Form proof',$3)`,
    [workflowId, family.workspaceId, userId],
  );
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,1,$4::jsonb,$5::jsonb,$6,$7)`,
    [
      versionId,
      family.workspaceId,
      workflowId,
      JSON.stringify(graph),
      JSON.stringify(compiled.envelope),
      compiled.checksum,
      userId,
    ],
  );
  await admin.query(
    `update app.workflows set published_version_id=$2 where id=$1`,
    [workflowId, versionId],
  );
  return {
    workspaceId: family.workspaceId,
    workflowId,
    versionId,
    viewerId,
    actorId: userId,
  };
}

/** Stores, without publishing, a second version with a changed Form config. */
export async function insertFormRevision(
  f: Readonly<{ workspaceId: string; workflowId: string; versionId: string }>,
  config: Readonly<Record<string, string>>,
): Promise<string> {
  const row = await admin.query<{ graph_json: WorkflowGraph }>(
    'select graph_json from app.workflow_versions where id=$1',
    [f.versionId],
  );
  const previous = row.rows[0]?.graph_json;
  if (previous === undefined) throw new Error('Missing graph');
  const graph: WorkflowGraph = {
    ...previous,
    nodes: previous.nodes.map((node) =>
      node.id === 'form'
        ? { ...node, config: { ...node.config, ...config } }
        : node,
    ),
  };
  const compiled = buildWorkflowExecutable({
    graph,
    catalog: composeExecutableCatalog(CORE_NODE_CATALOG),
  });
  const versionId = randomUUID();
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,2,$4::jsonb,$5::jsonb,$6,$7)`,
    [
      versionId,
      f.workspaceId,
      f.workflowId,
      JSON.stringify(graph),
      JSON.stringify(compiled.envelope),
      compiled.checksum,
      userId,
    ],
  );
  return versionId;
}

export function beforeAllFixture1() {
  store = createFormStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 4 }),
    (version) => ({
      checkpoint: createCheckpoint({
        workflowVersionId: version.id,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
    }),
  );
}

export function afterAllFixture2() {
  return store.close();
}
