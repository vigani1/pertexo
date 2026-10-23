import { expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  actorId,
  apiPool,
  apiUrl,
  createConnectionDatabase,
  createHash,
  createWorkflowAuthoringDatabase,
  createWorkflowIntegrationUsageDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  finishTransactionClient,
  otherWorkspaceId,
  parseDatabaseConfig,
  randomUUID,
  saveCurrentDraft,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerTransactionallyRebuildsDerivedIntegrationUsage(): void {
  it('transactionally rebuilds derived integration usage and serves bounded impact queries', async () => {
    const connectionId = randomUUID();
    const secretVersionId = randomUUID();
    const connectionDatabase = createConnectionDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const usageDatabase = createWorkflowIntegrationUsageDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const usageCatalog = Object.freeze({
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
      { definitionCatalog: usageCatalog },
    );
    try {
      await connectionDatabase.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId,
        providerKey: 'http',
        name: `Usage ${connectionId.slice(0, 8)}`,
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        sealed: {
          kmsKeyReference:
            'arn:aws:kms:eu-central-1:123456789012:key/usage-proof',
          encryptedDataKey: Buffer.alloc(32, 1).toString('base64url'),
          ciphertext: Buffer.from('usage-proof').toString('base64url'),
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          tag: Buffer.alloc(16, 3).toString('base64url'),
        },
        idempotencyKey: `usage-connection-${connectionId}`,
        requestHash: createHash('sha256').update(connectionId).digest('hex'),
      });
      const graph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('http-usage'),
            connectionRefs: { primary: connectionId },
          },
        ],
      };
      const created = await usageAuthoring.createWorkflow({
        actorId,
        emptyGraph: graph,
        idempotencyKey: `create-usage-${connectionId}`,
        name: 'Integration usage proof',
        workspaceId,
      });
      const published = await usageAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          usageAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: usageCatalog,
          },
        ),
        idempotencyKey: `publish-usage-${connectionId}`,
        requestHash: createHash('sha256')
          .update(`publish-${connectionId}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });
      const additionalVersionIds: string[] = [];
      for (const suffix of ['a', 'b']) {
        const additionalGraph = {
          ...emptyGraph,
          nodes: [
            {
              ...draftNode(`http-usage-${suffix}`),
              connectionRefs: { primary: connectionId },
            },
          ],
        };
        const additional = await usageAuthoring.createWorkflow({
          actorId,
          emptyGraph: additionalGraph,
          idempotencyKey: `create-usage-${connectionId}-${suffix}`,
          name: `Integration usage traversal ${suffix}`,
          workspaceId,
        });
        const additionalPublication = await usageAuthoring.publishWorkflow({
          actorId,
          representationTag: await currentRepresentationTag(
            usageAuthoring,
            workspaceId,
            {
              scopedWorkflowId: additional.workflowId,
              scopedActorId: actorId,
              definitionCatalog: usageCatalog,
            },
          ),
          idempotencyKey: `publish-usage-${connectionId}-${suffix}`,
          requestHash: createHash('sha256')
            .update(`publish-${connectionId}-${suffix}`)
            .digest('hex'),
          workflowId: additional.workflowId,
          workspaceId,
        });
        additionalVersionIds.push(additionalPublication.version.id);
      }

      const providerImpactIds: string[] = [];
      let providerAfter:
        | Readonly<{ workflowVersionId: string; connectionId: string }>
        | undefined;
      do {
        const page = await usageDatabase.findProviderOperationImpact({
          workspaceId,
          providerKey: 'http',
          operationKey: 'request',
          limit: 1,
          ...(providerAfter === undefined ? {} : { after: providerAfter }),
        });
        providerImpactIds.push(
          ...page.items.map(({ workflowVersionId }) => workflowVersionId),
        );
        providerAfter = page.nextCursor;
      } while (providerAfter !== undefined);
      expect(providerImpactIds.toSorted()).toEqual(
        [published.version.id, ...additionalVersionIds].toSorted(),
      );

      const connectionImpactIds: string[] = [];
      let connectionAfter:
        | Readonly<{
            workflowVersionId: string;
            providerKey: string;
            operationKey: string;
          }>
        | undefined;
      do {
        const page = await usageDatabase.findConnectionImpact({
          workspaceId,
          connectionId,
          limit: 1,
          ...(connectionAfter === undefined ? {} : { after: connectionAfter }),
        });
        connectionImpactIds.push(
          ...page.items.map(({ workflowVersionId }) => workflowVersionId),
        );
        connectionAfter = page.nextCursor;
      } while (connectionAfter !== undefined);
      expect(connectionImpactIds.toSorted()).toEqual(
        [published.version.id, ...additionalVersionIds].toSorted(),
      );
      await expect(
        usageDatabase.findConnectionImpact({
          workspaceId: otherWorkspaceId,
          connectionId,
        }),
      ).resolves.toEqual({ items: [] });

      const client = await apiPool.connect();
      let transactionOpen = false;
      let primaryError: unknown;
      try {
        await client.query('begin');
        transactionOpen = true;
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        await client.query(
          'delete from app.workflow_integration_usage where workflow_version_id = $1',
          [published.version.id],
        );
        await client.query('commit');
        transactionOpen = false;
      } catch (error: unknown) {
        primaryError = error;
      }
      await finishTransactionClient(client, {
        label: 'Missing integration-usage fixture deletion',
        primaryError,
        transactionOpen,
      });
      await saveCurrentDraft(usageAuthoring, {
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...graph,
          nodes: [{ ...graph.nodes[0], label: 'Presentation only' }],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const rebuilt = await usageAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          usageAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: usageCatalog,
          },
        ),
        idempotencyKey: `republish-usage-${connectionId}`,
        requestHash: createHash('sha256')
          .update(`republish-${connectionId}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(rebuilt).toMatchObject({
        reused: true,
        version: { id: published.version.id, graphJson: graph },
      });
      const rebuiltImpact = await usageDatabase.findConnectionImpact({
        workspaceId,
        connectionId,
      });
      expect(rebuiltImpact.items).toContainEqual(
        expect.objectContaining({
          workflowVersionId: published.version.id,
          connectionId,
        }),
      );
    } finally {
      await Promise.all([
        connectionDatabase.close(),
        usageDatabase.close(),
        usageAuthoring.close(),
      ]);
    }
  });
}
