import { describe, expect, it } from 'vitest';

import {
  CONNECTION_AUTH_TYPE,
  CompatibilityReleaseMismatchError,
  BASELINE_COMPATIBILITY_EXPECTATION,
  actorId,
  apiPool,
  apiUrl,
  authoring,
  createConnectionDatabase,
  createHash,
  createWorkflowAuthoringDatabase,
  createWorkflowIntegrationUsageDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  otherWorkspaceId,
  parseDatabaseConfig,
  baselineEmptyDefinitionCatalog,
  queryAsOwner,
  randomUUID,
  testDefinitionCatalog,
  workspaceId,
} from './support/workflow-authoring.integration.support.js';

describe('workflow publication projections', () => {
  it('uses canonical executable identity rather than JSON or presentation identity', async () => {
    const catalogAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    try {
      const baseGraph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('canonical', { a: 1, b: 2 }),
            label: 'First label',
            position: { x: 1, y: 2 },
          },
        ],
      };
      const created = await catalogAuthoring.createWorkflow({
        actorId,
        emptyGraph: baseGraph,
        idempotencyKey: 'create-canonical-proof',
        name: 'Canonical proof',
        workspaceId,
      });
      const first = await catalogAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          catalogAuthoring,
          workspaceId,
          created.workflowId,
          actorId,
          testDefinitionCatalog,
        ),
        idempotencyKey: 'publish-canonical-first',
        requestHash: '1'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      await expect(
        authoring.getVersion(
          workspaceId,
          created.workflowId,
          first.version.id,
          actorId,
        ),
      ).resolves.toMatchObject({
        checksum: first.version.checksum,
        graphJson: baseGraph,
      });
      await catalogAuthoring.saveDraft({
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...baseGraph,
          nodes: [
            {
              ...draftNode('canonical', { b: 2, a: 1 }),
              label: 'Presentation changed',
              position: { x: 500, y: 600 },
            },
          ],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const presentationOnly = await catalogAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          catalogAuthoring,
          workspaceId,
          created.workflowId,
          actorId,
          testDefinitionCatalog,
        ),
        idempotencyKey: 'publish-canonical-presentation',
        requestHash: '2'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(presentationOnly).toMatchObject({
        reused: true,
        version: { id: first.version.id, checksum: first.version.checksum },
      });

      await catalogAuthoring.saveDraft({
        actorId,
        expectedRevision: 2,
        graphJson: {
          ...baseGraph,
          nodes: [draftNode('canonical', { a: 1, b: 3 })],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const executableChange = await catalogAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          catalogAuthoring,
          workspaceId,
          created.workflowId,
          actorId,
          testDefinitionCatalog,
        ),
        idempotencyKey: 'publish-canonical-executable',
        requestHash: '3'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(executableChange.reused).toBe(false);
      expect(executableChange.version.id).not.toBe(first.version.id);
      expect(executableChange.version.checksum).not.toBe(
        first.version.checksum,
      );

      await authoring.saveDraft({
        actorId,
        expectedRevision: 3,
        graphJson: emptyGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      await expect(
        authoring.publishWorkflow({
          actorId,
          representationTag: await currentRepresentationTag(
            authoring,
            workspaceId,
            created.workflowId,
            actorId,
          ),
          idempotencyKey: 'publish-after-unsupported-history',
          requestHash: '4'.repeat(64),
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).resolves.toMatchObject({ replayed: false, reused: false });
    } finally {
      await catalogAuthoring.close();
    }
  });

  it('atomically persists an injected executable V2 publication projection', async () => {
    const checksum = `wf:v2:sha256:${'a'.repeat(64)}` as const;
    const executableDefinitionCatalog = baselineEmptyDefinitionCatalog;
    const executableJson = {
      schemaVersion: 2,
      marker: 'compiled-in-api',
      compatibilityReleaseEpoch: 1,
      compatibilityReleaseFingerprint:
        BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
    };
    const executableAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
        definitionCatalog: executableDefinitionCatalog,
        executableCompiler: () => ({
          checksum,
          executableSchemaVersion: 2,
          executableJson,
          compatibilityReleaseEpoch: 1,
          compatibilityReleaseFingerprint:
            BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
        }),
      },
    );
    try {
      const created = await executableAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'create-v2-publication-proof',
        name: 'V2 publication proof',
        workspaceId,
      });
      const representationTag = await currentRepresentationTag(
        executableAuthoring,
        workspaceId,
        created.workflowId,
        actorId,
        executableDefinitionCatalog,
      );
      const command = {
        actorId,
        representationTag,
        idempotencyKey: 'publish-v2-publication-proof',
        requestHash: '7'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      } as const;
      const published = await executableAuthoring.publishWorkflow(command);

      expect(published.version.checksum).toBe(checksum);
      await expect(
        queryAsOwner(
          `select checksum, executable_schema_version, executable_json,
                  compatibility_release_epoch
             from app.workflow_versions
            where workspace_id = $1 and id = $2`,
          [workspaceId, published.version.id],
          workspaceId,
        ),
      ).resolves.toEqual([
        {
          checksum,
          executable_schema_version: 2,
          executable_json: executableJson,
          compatibility_release_epoch: 1,
        },
      ]);

      const drifted = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        {
          compatibilityRelease: {
            ...BASELINE_COMPATIBILITY_EXPECTATION,
            fingerprint:
              'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          definitionCatalog: {
            schemaVersion: 1,
            releaseFingerprint:
              'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            definitions: [],
          },
          executableCompiler: () => ({
            checksum,
            executableSchemaVersion: 2,
            executableJson,
            compatibilityReleaseEpoch: 1,
            compatibilityReleaseFingerprint:
              BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          }),
        },
      );
      try {
        await expect(drifted.publishWorkflow(command)).resolves.toMatchObject({
          replayed: true,
          version: { id: published.version.id },
        });
        await expect(
          drifted.publishWorkflow({
            ...command,
            idempotencyKey: 'publish-v2-drifted-release',
            requestHash: '8'.repeat(64),
          }),
        ).rejects.toBeInstanceOf(CompatibilityReleaseMismatchError);
      } finally {
        await drifted.close();
      }

      const corruptCompiler = createWorkflowAuthoringDatabase(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        {
          compatibilityRelease: BASELINE_COMPATIBILITY_EXPECTATION,
          definitionCatalog: {
            schemaVersion: 1,
            releaseFingerprint: BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
            definitions: [],
          },
          executableCompiler: () => ({
            checksum,
            executableSchemaVersion: 2,
            executableJson: {
              ...executableJson,
              compatibilityReleaseFingerprint:
                'node-compat:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
            compatibilityReleaseEpoch: 1,
            compatibilityReleaseFingerprint:
              BASELINE_COMPATIBILITY_EXPECTATION.fingerprint,
          }),
        },
      );
      try {
        await expect(
          corruptCompiler.publishWorkflow({
            ...command,
            idempotencyKey: 'publish-v2-corrupt-envelope-release',
            requestHash: '9'.repeat(64),
          }),
        ).rejects.toThrow('does not match the locked authority');
      } finally {
        await corruptCompiler.close();
      }
    } finally {
      await executableAuthoring.close();
    }
  });

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
      schemaVersion: 1 as const,
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
          schemaVersion: 1,
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
          created.workflowId,
          actorId,
          usageCatalog,
        ),
        idempotencyKey: `publish-usage-${connectionId}`,
        requestHash: createHash('sha256')
          .update(`publish-${connectionId}`)
          .digest('hex'),
        workflowId: created.workflowId,
        workspaceId,
      });

      await expect(
        usageDatabase.findProviderOperationImpact({
          workspaceId,
          providerKey: 'http',
          operationKey: 'request',
          limit: 1,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            workflowVersionId: published.version.id,
            providerKey: 'http',
            operationKey: 'request',
            connectionId,
          },
        ],
      });
      await expect(
        usageDatabase.findConnectionImpact({ workspaceId, connectionId }),
      ).resolves.toMatchObject({
        items: [{ workflowVersionId: published.version.id, connectionId }],
      });
      await expect(
        usageDatabase.findConnectionImpact({
          workspaceId: otherWorkspaceId,
          connectionId,
        }),
      ).resolves.toEqual({ items: [] });

      const client = await apiPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        await client.query(
          'delete from app.workflow_integration_usage where workflow_version_id = $1',
          [published.version.id],
        );
        await client.query('commit');
      } finally {
        client.release();
      }
      await usageAuthoring.saveDraft({
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
          created.workflowId,
          actorId,
          usageCatalog,
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
      await expect(
        usageDatabase.findConnectionImpact({ workspaceId, connectionId }),
      ).resolves.toMatchObject({
        items: [{ workflowVersionId: published.version.id, connectionId }],
      });
    } finally {
      await Promise.all([
        connectionDatabase.close(),
        usageDatabase.close(),
        usageAuthoring.close(),
      ]);
    }
  });
});
