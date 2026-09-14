import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { createWorkflowIntegrationUsageDatabase } from '../src/connections/workflow-integration-usage.js';
import {
  Pool,
  apiBaseUrl,
  createHash,
  createInput,
  databaseUrl,
  migrationBaseUrl,
  ownerA,
  parseDatabaseConfig,
  randomUUID,
  registerCurrentConnectionsFixture,
  workspaceA,
  workspaceB,
} from './support/connections.integration.support.js';

const connections = registerCurrentConnectionsFixture();

describe('workflow integration usage pagination', () => {
  it('exhausts both tuple cursors with exact ordering and tenant scope', async () => {
    const connectionA = createInput();
    const connectionB = createInput();
    await connections.api.createConnection(connectionA);
    await connections.api.createConnection(connectionB);
    const versionIds = Array.from({ length: 3 }, () => randomUUID()).sort();
    const [versionA, versionB, versionC] = versionIds;
    if (
      versionA === undefined ||
      versionB === undefined ||
      versionC === undefined
    )
      throw new Error('Workflow version fixtures are incomplete');
    const ownerPool = new Pool({
      connectionString: databaseUrl(migrationBaseUrl),
    });
    let owner: PoolClient | undefined;
    try {
      owner = await ownerPool.connect();
      await owner.query('begin');
      await owner.query('set local role pertexo_owner');
      await owner.query("select set_config('app.workspace_id',$1,true)", [
        workspaceA,
      ]);
      for (const [index, versionId] of versionIds.entries()) {
        const workflowId = randomUUID();
        await owner.query(
          `insert into app.workflows
             (id,workspace_id,name,created_by)
           values ($1,$2,$3,$4)`,
          [workflowId, workspaceA, `Usage ${String(index)}`, ownerA],
        );
        await owner.query(
          `insert into app.workflow_versions
             (id,workspace_id,workflow_id,version_number,schema_version,
              graph_json,checksum,published_by)
           values ($1,$2,$3,1,1,'{}'::jsonb,$4,$5)`,
          [
            versionId,
            workspaceA,
            workflowId,
            `wf:v1:sha256:${createHash('sha256').update(versionId).digest('hex')}`,
            ownerA,
          ],
        );
        await owner.query(
          `insert into app.workflow_integration_usage
             (workspace_id,workflow_version_id,provider_key,operation_key,
              connection_id)
           values ($1,$2,'http','request',$3)`,
          [workspaceA, versionId, connectionA.connectionId],
        );
      }
      await owner.query(
        `insert into app.workflow_integration_usage
           (workspace_id,workflow_version_id,provider_key,operation_key,
            connection_id)
         values
           ($1,$2,'http','request',$3),
           ($1,$4,'http','upload',$5)`,
        [
          workspaceA,
          versionA,
          connectionB.connectionId,
          versionC,
          connectionA.connectionId,
        ],
      );
      await owner.query('commit');
    } finally {
      await owner?.query('rollback').catch(() => undefined);
      owner?.release();
      await ownerPool.end();
    }

    const usage = createWorkflowIntegrationUsageDatabase(
      parseDatabaseConfig({
        connectionString: databaseUrl(apiBaseUrl),
        max: 1,
      }),
    );
    try {
      const providerItems = [];
      let providerCursor:
        | Readonly<{ workflowVersionId: string; connectionId: string }>
        | undefined;
      do {
        const result = await usage.findProviderOperationImpact({
          workspaceId: workspaceA,
          providerKey: 'http',
          operationKey: 'request',
          limit: 1,
          ...(providerCursor === undefined ? {} : { after: providerCursor }),
        });
        providerItems.push(...result.items);
        providerCursor = result.nextCursor;
      } while (providerCursor !== undefined);
      expect(
        providerItems.map(({ workflowVersionId, connectionId }) => ({
          workflowVersionId,
          connectionId,
        })),
      ).toEqual(
        [
          ...versionIds.map((workflowVersionId) => ({
            workflowVersionId,
            connectionId: connectionA.connectionId,
          })),
          {
            workflowVersionId: versionA,
            connectionId: connectionB.connectionId,
          },
        ].sort((left, right) =>
          left.workflowVersionId === right.workflowVersionId
            ? left.connectionId.localeCompare(right.connectionId)
            : left.workflowVersionId.localeCompare(right.workflowVersionId),
        ),
      );

      const connectionItems = [];
      let connectionCursor:
        | Readonly<{
            workflowVersionId: string;
            providerKey: string;
            operationKey: string;
          }>
        | undefined;
      do {
        const result = await usage.findConnectionImpact({
          workspaceId: workspaceA,
          connectionId: connectionA.connectionId,
          limit: 2,
          ...(connectionCursor === undefined
            ? {}
            : { after: connectionCursor }),
        });
        connectionItems.push(...result.items);
        connectionCursor = result.nextCursor;
      } while (connectionCursor !== undefined);
      expect(
        connectionItems.map(({ workflowVersionId, operationKey }) => ({
          workflowVersionId,
          operationKey,
        })),
      ).toEqual([
        ...versionIds.map((workflowVersionId) => ({
          workflowVersionId,
          operationKey: 'request',
        })),
        { workflowVersionId: versionC, operationKey: 'upload' },
      ]);
      await expect(
        usage.findConnectionImpact({
          workspaceId: workspaceB,
          connectionId: connectionA.connectionId,
        }),
      ).resolves.toEqual({ items: [] });
      await expect(
        usage.findProviderOperationImpact({
          workspaceId: workspaceA,
          providerKey: 'http',
          operationKey: 'missing',
        }),
      ).resolves.toEqual({ items: [] });
      for (const limit of [0, 1_001])
        await expect(
          usage.findConnectionImpact({
            workspaceId: workspaceA,
            connectionId: connectionA.connectionId,
            limit,
          }),
        ).rejects.toThrow();
      await expect(
        usage.findProviderOperationImpact({
          workspaceId: workspaceA,
          providerKey: 'http',
          operationKey: 'request',
          after: { workflowVersionId: 'invalid', connectionId: randomUUID() },
        }),
      ).rejects.toThrow();
    } finally {
      await usage.close();
    }
  });
});
