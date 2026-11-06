import { afterAll, expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  authoring,
  CONNECTION_AUTH_TYPE,
  createConnectionStore,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
} from '../../support/workflow-authoring.js';
import { createRestoreFixture } from './version-restore.fixture.js';

const original = createWorkflowAuthoringStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: ['test.placeholder', 'test.removed', 'core.call'].map(
        (key) => ({ key, version: 1 }),
      ),
    },
  },
);
const current = createWorkflowAuthoringStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
  {
    definitionCatalog: {
      definitions: ['test.placeholder', 'core.call'].map((key) => ({
        key,
        version: 1,
      })),
    },
  },
);
const connections = createConnectionStore(
  parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
);
afterAll(async () => {
  await Promise.all([original.close(), current.close(), connections.close()]);
});

it.each([
  'removed definition',
  'removed connection',
  'removed Call target',
] as const)(
  'restores the supported version and preserves the exact unfinished draft with a %s',
  async (kind) => {
    const fixture = await createRestoreFixture(randomUUID(), original);
    let node = {
      ...draftNode('unfinished'),
      config: {},
      definition: { key: 'test.removed', version: 1 },
    };
    let removeBinding: () => Promise<void> = () => Promise.resolve();
    if (kind === 'removed connection') {
      const connectionId = randomUUID();
      await connections.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Old binding ${connectionId}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          kmsKeyReference: 'kms://fixture',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('fixture').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: randomUUID(),
        requestHash: 'a'.repeat(64),
      });
      node = {
        ...node,
        definition: { key: 'test.placeholder', version: 1 },
        connectionRefs: { primary: connectionId },
      };
      removeBinding = async () => {
        await queryAsOwner(
          'delete from app.connection_events where connection_id=$1',
          [connectionId],
          workspaceId,
        );
        await queryAsOwner(
          'with secrets as (delete from app.connection_secret_versions where connection_id=$1 returning id) delete from app.connections where id=$1 and exists(select 1 from secrets)',
          [connectionId],
          workspaceId,
        );
      };
    }
    if (kind === 'removed Call target') {
      const target = await authoring.createWorkflow({
        workspaceId,
        actorId,
        name: 'Former target',
        emptyGraph,
        idempotencyKey: randomUUID(),
      });
      node = {
        ...node,
        definition: { key: 'core.call', version: 1 },
        config: {
          target: {
            workflowId: target.workflowId,
            workflowVersionId: randomUUID(),
            executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
          },
        },
      };
      removeBinding = async () => {
        await queryAsOwner(
          'delete from app.workflow_drafts where workflow_id=$1',
          [target.workflowId],
          workspaceId,
        );
        await queryAsOwner(
          'delete from app.workflows where id=$1',
          [target.workflowId],
          workspaceId,
        );
      };
    }
    const displaced = { ...emptyGraph, nodes: [node] };
    await saveCurrentDraft(original, {
      workspaceId,
      actorId,
      workflowId: fixture.workflowId,
      expectedRevision: 3,
      graphJson: displaced,
    });
    await removeBinding();
    const restored = await current.restoreWorkflowVersion({
      workspaceId,
      actorId,
      workflowId: fixture.workflowId,
      versionId: fixture.firstVersionId,
      representationTag: await currentRepresentationTag(current, workspaceId, {
        scopedWorkflowId: fixture.workflowId,
        scopedActorId: actorId,
      }),
    });
    expect(restored.graphJson).toEqual(emptyGraph);
    expect(restored.recoveryCopyId).not.toBeNull();
    const copyId = restored.recoveryCopyId;
    if (copyId === null) throw new Error('Missing recovery workflow');
    expect(
      (await authoring.getDraft(workspaceId, copyId, actorId))?.graphJson,
    ).toEqual(displaced);
    expect(
      await authoring.getWorkflow(workspaceId, copyId, actorId),
    ).toMatchObject({ activationStatus: 'inactive', publishedVersionId: null });
    expect(
      await queryAsOwner(
        'select count(*)::int count from app.workflow_triggers where workflow_id=$1',
        [copyId],
        workspaceId,
      ),
    ).toEqual([{ count: 0 }]);
  },
);
