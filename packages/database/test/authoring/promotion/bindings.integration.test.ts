import { randomUUID, createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@pertexo/workflow-model';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import { createWorkspaceVariablesStore } from '../../../src/variables/store.js';
import { createDataTablesStore } from '../../../src/data-tables/store.js';
import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  saveCurrentDraft,
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
} from '../../support/workflow-authoring.js';
const keys = [
  'test.placeholder',
  'core.table_find',
  'core.table_upsert',
  'core.manual',
  'core.call',
  'core.terminate',
];
const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });
const db = createWorkflowAuthoringFixtureDatabase(config, {
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
const connections = createConnectionDatabase(config);
const variables = createWorkspaceVariablesStore(config);
const tables = createDataTablesStore(config);
const scope = () => ({ workspaceId, actorId });
function promotions() {
  if (db.promotions === undefined) throw new Error('Promotion store missing');
  return db.promotions;
}
const node = (
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
beforeAll(async () => {
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
});
afterAll(async () =>
  Promise.all([
    db.close(),
    connections.close(),
    variables.close(),
    tables.close(),
  ]),
);
async function published(
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
      representationTag: await currentRepresentationTag(
        db,
        workspaceId,
        created.workflowId,
        actorId,
      ),
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
async function connection(ws: string, actor: string, name: string) {
  const connectionId = randomUUID();
  await connections.createConnection({
    workspaceId: ws,
    actorId: actor,
    connectionId,
    secretVersionId: randomUUID(),
    providerKey: 'http',
    name,
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
async function promote(
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
it('uses only compatible active target connections by normalized name, and never copies credential bytes', async () => {
  const name = `HTTP ${randomUUID()}`;
  const sourceId = await connection(workspaceId, actorId, name);
  const selected = await published({
    ...emptyGraph,
    nodes: [
      {
        ...node('service', 'test.placeholder'),
        connectionRefs: { service: sourceId },
      },
    ],
  });
  const missing = await promotions().preview({
    ...scope(),
    selections: [selected],
    mode: 'draft',
  });
  expect(missing.compatible).toBe(false);
  expect(missing.requirements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'connection', status: 'missing' }),
    ]),
  );
  const targetId = await connection(
    otherWorkspaceId,
    otherActorId,
    ` ${name.toUpperCase()} `,
  );
  const { review, item } = await promote(selected);
  expect(
    review.workflows[0]?.proposedGraph.nodes[0]?.connectionRefs.service,
  ).toBe(targetId);
  expect(JSON.stringify(review)).not.toContain('PRIVATE_');
  expect(JSON.stringify(review)).not.toContain(sourceId);
  expect(
    (await db.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId))
      ?.graphJson.nodes[0]?.connectionRefs.service,
  ).toBe(targetId);
});
it('requires target variables without copying source values and makes changed names stale', async () => {
  const source = await variables.read(scope());
  await variables.replace({
    ...scope(),
    expectedRevision: source.revision,
    values: { RATE: 42 },
    idempotencyKey: randomUUID(),
  });
  const selection = await published({
    ...emptyGraph,
    nodes: [
      {
        ...node('calc', 'core.terminate'),
        inputMappings: { value: { kind: 'workspace_variable', name: 'RATE' } },
      },
    ],
  });
  expect(
    (
      await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'draft',
      })
    ).requirements,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'variable',
        name: 'RATE',
        status: 'missing',
      }),
    ]),
  );
  const targetScope = { workspaceId: otherWorkspaceId, actorId: otherActorId };
  const initial = await variables.read(targetScope);
  await variables.replace({
    ...targetScope,
    expectedRevision: initial.revision,
    values: { RATE: 7 },
    idempotencyKey: randomUUID(),
  });
  const { review } = await promote(selection);
  expect((await variables.read(targetScope)).values.RATE).toBe(7);
  expect(JSON.stringify(review)).not.toContain('"RATE":42');
  const current = await variables.read(targetScope);
  await variables.replace({
    ...targetScope,
    expectedRevision: current.revision,
    values: { OTHER: 7 },
    idempotencyKey: randomUUID(),
  });
  await expect(
    promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'draft',
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ reason: 'stale' });
});
it('rebinds renamed stable table IDs by current name while preserving old output aliases', async () => {
  const name = `Amounts_${randomUUID().replaceAll('-', '')}`;
  const columns = [
    { name: 'key', type: 'text' as const, required: true },
    { name: 'amount', type: 'number' as const, required: true },
  ];
  const source = await tables.create({
    ...scope(),
    name,
    columns,
    keyColumn: 'key',
    idempotencyKey: randomUUID(),
  });
  await tables.editSchema({
    ...scope(),
    tableId: source.id,
    expectedRevision: 1,
    change: { operation: 'rename_column', columnId: 'amount', name: 'total' },
    idempotencyKey: randomUUID(),
  });
  const targetScope = { workspaceId: otherWorkspaceId, actorId: otherActorId };
  const target = await tables.create({
    ...targetScope,
    name,
    columns: [
      columns[0] ?? { name: 'key', type: 'text', required: true },
      { name: 'total', type: 'number', required: true },
    ],
    keyColumn: 'key',
    idempotencyKey: randomUUID(),
  });
  const selection = await published({
    ...emptyGraph,
    nodes: [
      node('find', 'core.table_find', {
        table: name,
        columnBindings: { key: 'key', amount: 'amount' },
      }),
    ],
  });
  const { review } = await promote(selection);
  expect(review.workflows[0]?.proposedGraph.nodes[0]?.config).toEqual({
    table: name,
    columnBindings: { key: 'key', amount: 'total' },
  });
  expect(
    (await tables.list(targetScope)).tables.find(
      (table) => table.id === target.id,
    )?.rowCount,
  ).toBe(0);
  await tables.editSchema({
    ...targetScope,
    tableId: target.id,
    expectedRevision: 1,
    change: { operation: 'remove_column', columnId: 'total', confirm: true },
    idempotencyKey: randomUUID(),
  });
  expect(
    (
      await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'draft',
      })
    ).compatible,
  ).toBe(false);
});
it('requires the exact promoted child version and retains independent historical correspondences', async () => {
  const callable: WorkflowGraph = {
    ...emptyGraph,
    nodes: [node('manual', 'core.manual'), node('stop', 'core.terminate')],
    callable: {
      input: { type: 'string' },
      resultType: { type: 'string' },
      result: { kind: 'run_input', path: '$' },
    },
  };
  const child = await published(callable);
  const parent = await published({
    ...callable,
    nodes: [
      ...callable.nodes,
      node('call', 'core.call', {
        target: {
          workflowId: child.workflowId,
          workflowVersionId: child.versionId,
          executableChecksum: child.checksum,
        },
      }),
    ],
  });
  expect(
    (
      await promotions().preview({
        ...scope(),
        selections: [parent],
        mode: 'draft',
      })
    ).requirements,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'call', status: 'missing' }),
    ]),
  );
  const targetChild = await promote(child, 'publish');
  const targetParent = await promote(parent, 'publish');
  const pin = targetParent.review.workflows[0]?.proposedGraph.nodes.find(
    (step) => step.id === 'call',
  )?.config.target;
  expect(pin).toMatchObject({
    workflowId: targetChild.item.targetWorkflowId,
    workflowVersionId: targetChild.item.publishedVersionId,
  });
  const draft = await db.getDraft(workspaceId, child.workflowId, actorId);
  if (draft === null) throw new Error('Missing child draft');
  await saveCurrentDraft(db, {
    ...scope(),
    workflowId: child.workflowId,
    expectedRevision: draft.revision,
    graphJson: { ...callable, settings: { maxRunDurationMs: 5000 } },
  });
  const next = (
    await db.publishWorkflow({
      ...scope(),
      workflowId: child.workflowId,
      representationTag: await currentRepresentationTag(
        db,
        workspaceId,
        child.workflowId,
        actorId,
      ),
      requestHash: 'b'.repeat(64),
      idempotencyKey: randomUUID(),
    })
  ).version;
  await promote(
    { workflowId: child.workflowId, versionId: next.id },
    'publish',
  );
  const again = await promotions().preview({
    ...scope(),
    selections: [parent],
    mode: 'draft',
  });
  expect(
    again.workflows[0]?.proposedGraph.nodes.find((step) => step.id === 'call')
      ?.config.target,
  ).toEqual(pin);
});
