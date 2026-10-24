import { createWorkspaceDatabase } from '../../../src/database.js';
import { acceptPreviewRun } from '../../../src/previews/runs/acceptance.js';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { workflowDraftRepresentationTag } from '@pertexo/workflow-model/server';
import {
  actorId,
  apiUrl,
  testDefinitionCatalog,
  draftNode,
  emptyGraph,
  identity,
  queryAsOwner,
  workspaceId,
} from '../../support/workflow-authoring.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { createConnectionDatabase } from '../../../src/connections/repository.js';
import {
  CONNECTION_AUTH_TYPE,
  ConnectionNotFoundError,
  ConnectionSharingRevisionConflictError,
} from '../../../src/connections/contract.js';

const builder = randomUUID(),
  viewer = randomUUID(),
  creator = randomUUID();
let connections: ReturnType<typeof createConnectionDatabase>;
let authoring: ReturnType<typeof createWorkflowAuthoringFixtureDatabase>;
let restricted = '',
  workspaceShared = '',
  creatorRestricted = '';
async function createConnection(name: string, creatorId = actorId) {
  const id = randomUUID();
  await connections.createConnection({
    workspaceId,
    actorId: creatorId,
    connectionId: id,
    secretVersionId: randomUUID(),
    providerKey: 'http',
    authType: CONNECTION_AUTH_TYPE.httpHeaders,
    name,
    idempotencyKey: randomUUID(),
    requestHash: 'c'.repeat(64),
    sealed: {
      kmsKeyReference: 'alias/fixture',
      encryptedDataKey: Buffer.alloc(96, 1).toString('base64url'),
      ciphertext: Buffer.from('encrypted-fixture').toString('base64url'),
      nonce: Buffer.alloc(12, 1).toString('base64url'),
      tag: Buffer.alloc(16, 1).toString('base64url'),
    },
  });
  return id;
}
async function share(connectionId: string, userIds: string[]) {
  const current = await connections.readConnectionSharing({
    workspaceId,
    actorId,
    connectionId,
  });
  return connections.replaceConnectionSharing({
    workspaceId,
    actorId,
    connectionId,
    idempotencyKey: randomUUID(),
    request: {
      mode: 'restricted',
      expectedSharingRevision: current.revision,
      userIds,
    },
  });
}
const read = (reader: string, connectionId = restricted) =>
  connections.readConnection({ workspaceId, actorId: reader, connectionId });
const lookup = (reader: string, connectionId = restricted) =>
  connections.resolveConnectionLookupSecret({
    workspaceId,
    actorId: reader,
    connectionId,
    expectedProviderKey: 'http',
    purpose: 'http.lookup',
  });

beforeAll(async () => {
  authoring = createWorkflowAuthoringFixtureDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    { definitionCatalog: testDefinitionCatalog },
  );
  connections = createConnectionDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 3 }),
  );
  for (const [id, role] of [
    [builder, 'builder'],
    [viewer, 'viewer'],
    [creator, 'admin'],
  ] as const) {
    await identity.createUser({
      id,
      email: `${id}@example.test`,
      displayName: `Sharing ${role}`,
    });
    await queryAsOwner(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,$3,'active')",
      [workspaceId, id, role],
      workspaceId,
    );
  }
  restricted = await createConnection('Private headers');
  workspaceShared = await createConnection('Workspace headers');
  creatorRestricted = await createConnection('Creator headers', creator);
  await share(restricted, []);
  await share(creatorRestricted, []);
  await identity.changeWorkspaceMemberRole({
    workspaceId,
    actorUserId: actorId,
    targetUserId: creator,
    role: 'builder',
    expectedRoleRevision: 1,
    idempotencyKey: randomUUID(),
  });
}, 30_000);
afterAll(async () => {
  await Promise.all([connections.close(), authoring.close()]);
});

it('filters discovery before pagination and keeps default metadata, creator access and the role ceiling', async () => {
  const listed = await connections.listConnections({
    workspaceId,
    actorId: builder,
    limit: 1,
  });
  expect(listed.items.map((row) => row.id)).toEqual([workspaceShared]);
  expect(listed.nextCursor).toBeUndefined();
  expect((await read(viewer, workspaceShared))?.name).toBe('Workspace headers');
  expect(await read(builder)).toBeNull();
  expect((await read(creator, creatorRestricted))?.name).toBe(
    'Creator headers',
  );
  await expect(lookup(builder)).rejects.toBeInstanceOf(ConnectionNotFoundError);
  await share(restricted, [viewer]);
  expect(await read(viewer)).toBeNull();
  await expect(lookup(viewer)).rejects.toBeInstanceOf(ConnectionNotFoundError);
  await expect(
    connections.readConnectionSharing({
      workspaceId,
      actorId: viewer,
      connectionId: restricted,
    }),
  ).rejects.toBeInstanceOf(ConnectionNotFoundError);
});

it('shares Use with bounded current members, checks revisions and audits one exact replay without changing the secret', async () => {
  const before = await connections.readConnectionSharing({
    workspaceId,
    actorId,
    connectionId: restricted,
  });
  const secret = (await read(actorId))?.currentSecretVersionId;
  const request = {
    workspaceId,
    actorId,
    connectionId: restricted,
    idempotencyKey: randomUUID(),
    request: {
      mode: 'restricted' as const,
      expectedSharingRevision: before.revision,
      userIds: [builder, viewer],
    },
  };
  const changed = await connections.replaceConnectionSharing(request);
  expect(changed.revision).toBe(before.revision + 1);
  expect(changed.members).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ userId: builder, active: true }),
    ]),
  );
  expect(await connections.replaceConnectionSharing(request)).toEqual({
    ...changed,
    replayed: true,
  });
  expect((await read(builder))?.name).toBe('Private headers');
  expect((await lookup(builder)).secretVersionId).toBe(secret);
  expect((await read(actorId))?.currentSecretVersionId).toBe(secret);
  await expect(
    connections.replaceConnectionSharing({
      ...request,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toBeInstanceOf(ConnectionSharingRevisionConflictError);
  await expect(
    connections.replaceConnectionSharing({
      ...request,
      idempotencyKey: randomUUID(),
      request: {
        ...request.request,
        expectedSharingRevision: changed.revision,
        userIds: [randomUUID()],
      },
    }),
  ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  const facts = await queryAsOwner<{ metadata: Record<string, unknown> }>(
    "select metadata from app.audit_events where workspace_id=$1 and target_id=$2 and action='connection.sharing_changed' and metadata->>'revision'=$3",
    [workspaceId, restricted, String(changed.revision)],
    workspaceId,
  );
  expect(facts).toHaveLength(1);
  expect(JSON.stringify(facts)).not.toContain('encrypted-fixture');
});

it('keeps an unchanged unavailable draft binding but admits every new site and publication', async () => {
  await share(restricted, [builder]);
  const graph = {
    ...emptyGraph,
    nodes: [{ ...draftNode('request'), connectionRefs: { auth: restricted } }],
  };
  const created = await authoring.createWorkflow({
    workspaceId,
    actorId,
    name: 'Credential delegation',
    emptyGraph: graph,
    idempotencyKey: randomUUID(),
  });
  const workflowId = created.workflowId;
  const admitted = await authoring.getDraft(workspaceId, workflowId, builder);
  if (admitted === null) throw new Error('Draft unavailable');
  await expect(
    authoring.publishWorkflow({
      workspaceId,
      workflowId,
      actorId: builder,
      idempotencyKey: randomUUID(),
      requestHash: 'e'.repeat(64),
      representationTag: workflowDraftRepresentationTag({
        workflowId,
        revision: admitted.revision,
        graph: admitted.graphJson,
        compatibilityFingerprint: admitted.compatibility.fingerprint,
      }),
    }),
  ).resolves.toBeDefined();
  await share(restricted, []);
  async function save(next: typeof graph, reader = builder) {
    const current = await authoring.getDraft(workspaceId, workflowId, reader);
    if (current === null) throw new Error('Draft unavailable');
    return authoring.saveDraft({
      workspaceId,
      workflowId,
      actorId: reader,
      graphJson: next,
      expectedRevision: current.revision,
      representationTag: workflowDraftRepresentationTag({
        workflowId,
        revision: current.revision,
        graph: current.graphJson,
        compatibilityFingerprint: current.compatibility.fingerprint,
      }),
    });
  }
  const first = graph.nodes[0];
  if (first === undefined) throw new Error('Fixture step unavailable');
  await expect(
    save({
      ...graph,
      nodes: [{ ...first, config: { destination: 'changed' } }],
    }),
  ).resolves.toBeDefined();
  await expect(
    save({
      ...graph,
      nodes: [
        ...graph.nodes,
        { ...draftNode('another'), connectionRefs: { auth: restricted } },
      ],
    }),
  ).rejects.toBeInstanceOf(InvalidWorkflowGraphError);
  const current = await authoring.getDraft(workspaceId, workflowId, builder);
  if (current === null) throw new Error('Draft unavailable');
  await expect(
    authoring.publishWorkflow({
      workspaceId,
      workflowId,
      actorId: builder,
      idempotencyKey: randomUUID(),
      requestHash: 'd'.repeat(64),
      representationTag: workflowDraftRepresentationTag({
        workflowId,
        revision: current.revision,
        graph: current.graphJson,
        compatibilityFingerprint: current.compatibility.fingerprint,
      }),
    }),
  ).rejects.toBeInstanceOf(InvalidWorkflowGraphError);
});

it('admits a real preview only while the author can use every credential', async () => {
  const database = createWorkspaceDatabase(
    parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
  );
  try {
    const node = {
      ...draftNode('request'),
      connectionRefs: { auth: restricted },
    };
    const created = await authoring.createWorkflow({
      workspaceId,
      actorId,
      name: 'Preview credential fence',
      emptyGraph: { ...emptyGraph, nodes: [node] },
      idempotencyKey: randomUUID(),
    });
    const preview = (key: string) =>
      database.withWorkspace(workspaceId, (transaction) =>
        acceptPreviewRun(transaction, {
          actorUserId: builder,
          workflowId: created.workflowId,
          nodeId: node.id,
          draftRevision: 1,
          draftFingerprint: 'a'.repeat(64),
          definitionKey: node.definition.key,
          definitionVersion: node.definition.version,
          executorKey: node.definition.key,
          executorVersion: node.definition.version,
          executableNode: node,
          executionDeadlineAt: new Date(Date.now() + 60_000),
          expiresAt: new Date(Date.now() + 3600_000),
          dryRun: 'not_supported',
          input: { kind: 'manual', value: {} },
          keyHash: key.repeat(64),
          requestHash: 'c'.repeat(64),
          mayContactProvider: true,
          mayCauseExternalSideEffect: true,
          operation: 'preview.execute',
          scope: `${builder}:${created.workflowId}`,
          sideEffectClass: 'unsafe',
          traceparent: undefined,
        }),
      );
    await share(restricted, [builder]);
    await expect(preview('a')).resolves.toMatchObject({ status: 'queued' });
    await share(restricted, []);
    await expect(preview('b')).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
  } finally {
    await database.close();
  }
});

it('removes named grants and invalidates sharing forms on removal, and never exempts a removed creator', async () => {
  const before = await share(restricted, [builder]);
  await identity.removeWorkspaceMember({
    workspaceId,
    actorUserId: actorId,
    targetUserId: builder,
    expectedRoleRevision: 1,
    idempotencyKey: randomUUID(),
  });
  const after = await connections.readConnectionSharing({
    workspaceId,
    actorId,
    connectionId: restricted,
  });
  expect(after.revision).toBeGreaterThan(before.revision);
  expect(after.members).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ userId: builder })]),
  );
  await expect(read(builder)).rejects.toBeInstanceOf(ConnectionNotFoundError);
  await identity.removeWorkspaceMember({
    workspaceId,
    actorUserId: actorId,
    targetUserId: creator,
    expectedRoleRevision: 2,
    idempotencyKey: randomUUID(),
  });
  await expect(lookup(creator, creatorRestricted)).rejects.toBeInstanceOf(
    ConnectionNotFoundError,
  );
  expect((await read(actorId, creatorRestricted))?.name).toBe(
    'Creator headers',
  );
});
