import { expect, it } from 'vitest';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';

import {
  CONNECTION_AUTH_TYPE,
  actorId,
  apiUrl,
  createConnectionDatabase,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerNamesStepConnectionIsUnknown(): void {
  it('names the step when its connection is unknown or revoked', async () => {
    const connectionId = randomUUID();
    const connectionDatabase = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const catalog = Object.freeze({
      definitions: Object.freeze([
        Object.freeze({
          key: 'test.placeholder',
          version: 1,
          integration: Object.freeze({
            providerKey: 'http',
            operationKey: 'request',
            connectionSlots: Object.freeze(['primary']),
          }),
        }),
      ]),
    });
    const usageAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: catalog },
    );
    async function publishWith(reference: string, label: string) {
      const created = await usageAuthoring.createWorkflow({
        actorId,
        emptyGraph: {
          ...emptyGraph,
          nodes: [
            { ...draftNode('send'), connectionRefs: { primary: reference } },
          ],
        },
        idempotencyKey: `create-${label}-${connectionId}`,
        name: `Connection reference ${label}`,
        workspaceId,
      });
      return usageAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          usageAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: catalog,
          },
        ),
        idempotencyKey: `publish-${label}-${connectionId}`,
        requestHash: createHash('sha256')
          .update(`publish-${label}-${connectionId}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });
    }
    const refused = {
      issues: [
        expect.objectContaining({
          path: '$.nodes.send.connectionRefs.primary',
          message:
            'This connection is unavailable. Choose a connection you can use.',
        }),
      ],
    };
    try {
      const unknown = publishWith(randomUUID(), 'unknown');
      await expect(unknown).rejects.toThrow(InvalidWorkflowGraphError);
      await expect(unknown).rejects.toMatchObject(refused);
      await connectionDatabase.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Revoked ${connectionId.slice(0, 8)}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          kmsKeyReference:
            'arn:aws:kms:eu-central-1:123456789012:key/revoked-proof',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('revoked-proof').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: `revoked-connection-${connectionId}`,
        requestHash: createHash('sha256').update(connectionId).digest('hex'),
      });
      await connectionDatabase.revokeConnection({
        workspaceId,
        actorId,
        connectionId,
      });
      await expect(publishWith(connectionId, 'revoked')).rejects.toMatchObject(
        refused,
      );
    } finally {
      await Promise.all([connectionDatabase.close(), usageAuthoring.close()]);
    }
  });
}
