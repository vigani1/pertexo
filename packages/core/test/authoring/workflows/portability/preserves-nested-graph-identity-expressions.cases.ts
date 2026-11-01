import { expect, it } from 'vitest';
import {
  parseWorkflowGraphDraft,
  projectWorkflowPortableManifest,
} from '@pertexo/workflow-model';
import { workflowDefinitionCatalogFingerprint } from '@pertexo/workflow-model/server';

import { WorkflowPortabilityValidationError } from '../../../../src/authoring/workflows/errors.js';

import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  apiUrl,
  parseDatabaseConfig,
  emptyGraph,
  draftNode,
  randomUUID,
  queryAsOwner,
  createConnectionDatabase,
  CONNECTION_AUTH_TYPE,
  createHash,
} from '../../../support/workflow-authoring.js';
import {
  catalog,
  portableCatalog,
  database,
  command,
  inputForPreview,
} from './fixture.js';

export function registerPreservesNestedGraphIdentityExpressions(): void {
  it('preserves nested graph identity and expressions, rebinds explicit destination slots and never accesses secret bytes', async () => {
    const connections = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const scopedCatalog = {
      ...catalog,
      definitions: [
        ...catalog.definitions,
        { key: 'core.foreach', version: 1 },
      ],
    };
    const scopedPortableCatalog = {
      ...portableCatalog,
      definitions: [
        {
          key: 'test.placeholder',
          version: 1,
          configVersion: 1,
          slots: [
            { slot: 'account', providerKey: 'http', authType: 'http_headers' },
          ],
          validateConfig: () => true,
        },
        {
          key: 'core.foreach',
          version: 1,
          configVersion: 1,
          slots: [],
          validateConfig: () => true,
        },
      ],
    };
    const db = database({
      definitionCatalog: scopedCatalog,
      portableCatalog: scopedPortableCatalog,
    });
    const destinationConnection = randomUUID(),
      foreignConnection = randomUUID();
    const createConnection = (id: string, workspace: string, actor: string) =>
      connections.createConnection({
        workspaceId: workspace,
        actorId: actor,
        connectionId: id,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        name: `Portability ${id}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        idempotencyKey: randomUUID(),
        requestHash: createHash('sha256').update(id).digest('hex'),
        sealed: {
          kmsKeyReference: 'arn:aws:kms:region:account:key/portability',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('never-export-secret').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
      });
    try {
      await createConnection(destinationConnection, workspaceId, actorId);
      await createConnection(foreignConnection, otherWorkspaceId, otherActorId);
      const graph = parseWorkflowGraphDraft({
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('loop'),
            definition: { key: 'core.foreach', version: 1 },
            structured: {
              kind: 'for_each',
              maxIterations: 10,
              maxConcurrency: 2,
              body: {
                ...emptyGraph,
                inputPorts: ['item', 'ordinal'],
                outputPorts: ['result'],
                nodes: [
                  {
                    ...draftNode('nested'),
                    inputMappings: {
                      value: {
                        kind: 'expression',
                        language: 'jsonata',
                        expression:
                          '$lookup(nodeOutputs, runInput.stepId).value',
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      });
      const manifest = projectWorkflowPortableManifest(
        graph,
        scopedPortableCatalog,
      );
      expect(manifest.connectionSlots).toEqual([
        {
          nodeId: 'nested',
          slot: 'account',
          providerKey: 'http',
          authType: 'http_headers',
        },
      ]);
      const input = command({
        manifest,
        bindings: [
          {
            nodeId: 'nested',
            slot: 'account',
            connectionId: destinationConnection,
          },
        ],
        expectedCompatibilityFingerprint:
          workflowDefinitionCatalogFingerprint(scopedCatalog),
      });
      expect(
        (
          await db.previewWorkflowImport({
            ...inputForPreview(input),
            bindings: [],
          })
        ).compatible,
      ).toBe(false);
      for (const id of [foreignConnection, randomUUID()]) {
        await expect(
          db.importWorkflow({
            ...input,
            idempotencyKey: randomUUID(),
            bindings: [{ nodeId: 'nested', slot: 'account', connectionId: id }],
          }),
        ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
      }
      const accepted = await db.importWorkflow(input);
      const draft = await db.getDraft(
        workspaceId,
        accepted.workflowId,
        actorId,
      );
      const expected = structuredClone(graph);
      const loop = expected.nodes[0];
      if (loop?.structured?.body.nodes[0] === undefined)
        throw new Error('Expected structured fixture');
      const rebound = {
        ...expected,
        nodes: [
          {
            ...loop,
            structured: {
              ...loop.structured,
              body: {
                ...loop.structured.body,
                nodes: [
                  {
                    ...loop.structured.body.nodes[0],
                    connectionRefs: { account: destinationConnection },
                  },
                ],
              },
            },
          },
        ],
      };
      expect(draft?.graphJson).toEqual(rebound);
      const secretAccess = await queryAsOwner(
        "select action from app.audit_events where workspace_id=$1 and action like '%credential_accessed%'",
        [workspaceId],
        workspaceId,
      );
      expect(secretAccess).toEqual([]);
      await connections.revokeConnection({
        workspaceId,
        actorId,
        connectionId: destinationConnection,
      });
      expect(await db.importWorkflow(input)).toEqual(accepted);
      await expect(
        db.importWorkflow({ ...input, idempotencyKey: randomUUID() }),
      ).rejects.toBeInstanceOf(WorkflowPortabilityValidationError);
    } finally {
      await connections.close();
    }
  });
}
