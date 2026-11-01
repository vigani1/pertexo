import { connectionCreateRequestSchema } from '@pertexo/contracts';
import { randomUUID, createHash } from 'node:crypto';
import { expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { createWorkflowAuthoringFixtureDatabase } from '../../../support/workflow-authoring-admission.fixture.js';
import { createDataTablesStore } from '../../../../src/data-tables/store.js';
import {
  actorId,
  workspaceId,
  otherWorkspaceId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  saveCurrentDraft,
  createConnectionStore,
  CONNECTION_AUTH_TYPE,
} from '../../../support/workflow-authoring.js';

const keys = [
  'test.placeholder',
  'core.table_find',
  'core.table_upsert',
  'core.manual',
  'core.call',
  'core.terminate',
];

export const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });

export const db = createWorkflowAuthoringFixtureDatabase(config, {
  definitionCatalog: { definitions: keys.map((key) => ({ key, version: 1 })) },
  portableCatalog: {
    definitions: keys.map((key) => ({
      key,
      version: 1,
      configVersion: 1,
      slots:
        key === 'test.placeholder'
          ? [
              {
                slot: 'service',
                providerKey: 'http',
                authType: CONNECTION_AUTH_TYPE.httpHeaders,
              },
            ]
          : [],
      validateConfig: () => true,
    })),
  },
});

const connections = createConnectionStore(config);

export const tables = createDataTablesStore(config);

export const scope = () => ({ workspaceId, actorId });

export function promotions() {
  if (db.promotions === undefined) throw new Error('Promotion store missing');
  return db.promotions;
}

export const node = (
  id: string,
  key: string,
  configuration: WorkflowNode['config'] = {},
): WorkflowNode => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: configuration,
  position: { x: 0, y: 0 },
  inputMappings: {},
  connectionRefs: {},
});

export async function published(
  graph: WorkflowGraph,
  name = `Binding ${randomUUID()}`,
) {
  const created = await db.createWorkflow({
    ...scope(),
    name,
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  await saveCurrentDraft(db, {
    ...scope(),
    workflowId: created.workflowId,
    expectedRevision: 1,
    graphJson: graph,
  });
  const version = (
    await db.publishWorkflow({
      ...scope(),
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(db, workspaceId, {
        scopedWorkflowId: created.workflowId,
        scopedActorId: actorId,
      }),
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    })
  ).version;
  return {
    workflowId: created.workflowId,
    versionId: version.id,
    checksum: version.checksum,
  };
}

export async function connection(ws: string, actor: string, name: string) {
  const connectionId = randomUUID();
  await connections.createConnection({
    workspaceId: ws,
    actorId: actor,
    connectionId,
    secretVersionId: randomUUID(),
    providerKey: 'http',
    name: connectionCreateRequestSchema.parse({
      providerKey: 'http',
      name,
      credential: {
        type: 'http_headers',
        headers: { authorization: 'fixture' },
      },
    }).name,
    authType: CONNECTION_AUTH_TYPE.httpHeaders,
    idempotencyKey: randomUUID(),
    requestHash: createHash('sha256').update(connectionId).digest('hex'),
    sealed: {
      kmsKeyReference: 'arn:aws:kms:region:account:key/promotion',
      encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
      ciphertext: Buffer.from(`PRIVATE_${ws}`).toString('base64url'),
      nonce: Buffer.alloc(12, 2).toString('base64url'),
      tag: Buffer.alloc(16, 3).toString('base64url'),
    },
  });
  return connectionId;
}

export async function promote(
  selection: { workflowId: string; versionId: string },
  mode: 'draft' | 'publish' = 'draft',
) {
  const review = await promotions().preview({
    ...scope(),
    selections: [selection],
    mode,
  });
  expect(review.compatible, JSON.stringify(review.requirements)).toBe(true);
  const result = await promotions().apply({
    ...scope(),
    selections: [selection],
    mode,
    fingerprint: review.fingerprint,
    acknowledgeTargetChanges: [],
    idempotencyKey: randomUUID(),
  });
  const item = result.items[0];
  if (item === undefined) throw new Error('Missing promoted workflow');
  return { review, item };
}

export async function beforeAllFixture1() {
  await queryAsOwner(
    "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active') on conflict(workspace_id,user_id) do update set role='builder',status='active'",
    [otherWorkspaceId, actorId],
    otherWorkspaceId,
  );
  await promotions().setTarget({
    ...scope(),
    expectedRevision: 0,
    expectedTargetWorkspaceId: null,
    targetWorkspaceId: otherWorkspaceId,
    idempotencyKey: randomUUID(),
  });
}

export async function afterAllFixture2() {
  return Promise.all([db.close(), connections.close(), tables.close()]);
}
