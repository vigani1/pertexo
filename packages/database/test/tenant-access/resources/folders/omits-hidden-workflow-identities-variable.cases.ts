import { connectionScope } from '../../../../src/tenant-access/resources/connections/scope.js';
import { inspectPromotionCallDependencies } from '../../../../src/authoring/promotion/preparation/calls.js';
import { PromotionGraphBudget } from '../../../../src/authoring/promotion/preparation/graph.js';
import { readFolderScope } from '../../../../src/tenant-access/resources/facts.queries.js';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { requireWorkflowCallTargets } from '../../../../src/tenant-access/resources/bindings.queries.js';
import { createWorkspaceVariablesStore } from '../../../../src/variables/settings.repository.js';
import { createConnectionDatabase } from '../../../../src/connections/repository.js';
import { CONNECTION_AUTH_TYPE } from '../../../../src/connections/contract.js';

import { withTenantScopedClient } from '../../../../src/tenant-access/transactions.js';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  apiPool,
  emptyGraph,
  draftNode,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../../support/workflow-authoring.js';
import { parseDatabaseConfig } from '../../../../src/config.js';

import { builder, publicId } from './fixture.js';

export function registerOmitsHiddenWorkflowIdentitiesVariable(): void {
  it('omits hidden workflow identities from variable and connection usage before pagination', async () => {
    for (const id of [workflowId, publicId]) {
      const graph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('variable'),
            inputMappings: {
              amount: { kind: 'workspace_variable', name: 'CURRENCY' },
            },
          },
        ],
      };
      await queryAsOwner(
        'update app.workflow_drafts set graph_json=$3::json where workspace_id=$1 and workflow_id=$2',
        [workspaceId, id, JSON.stringify(graph)],
        workspaceId,
      );
    }
    const config = parseDatabaseConfig({ connectionString: apiUrl, max: 2 });
    const variables = createWorkspaceVariablesStore(config);
    const connections = createConnectionDatabase(config);
    const connectionId = randomUUID();
    try {
      const usage = await variables.usage({
        workspaceId,
        actorId: builder,
        name: 'CURRENCY',
        limit: 1,
      });
      expect(usage.items.map(({ workflowId }) => workflowId)).toEqual([
        publicId,
      ]);
      expect(usage.next).toBeNull();
      await connections.createConnection({
        workspaceId,
        actorId,
        connectionId,
        secretVersionId: randomUUID(),
        providerKey: 'http',
        authType: CONNECTION_AUTH_TYPE.httpHeaders,
        name: 'Shared connection',
        idempotencyKey: randomUUID(),
        requestHash: 'c'.repeat(64),
        sealed: {
          kmsKeyReference: 'arn:aws:kms:eu-central-1:123456789012:key/example',
          encryptedDataKey: Buffer.alloc(96, 1).toString('base64url'),
          ciphertext: Buffer.from('encrypted-fixture').toString('base64url'),
          nonce: Buffer.alloc(12, 1).toString('base64url'),
          tag: Buffer.alloc(16, 1).toString('base64url'),
        },
      });
      await queryAsOwner(
        `insert into app.workflow_integration_usage(workspace_id,workflow_version_id,provider_key,operation_key,connection_id)
      select workspace_id,id,'http','request',$2 from app.workflow_versions where workspace_id=$1 and workflow_id=any($3::uuid[])`,
        [workspaceId, connectionId, [workflowId, publicId]],
        workspaceId,
      );
      const page = await connections.listConnectionUsage({
        workspaceId,
        actorId: builder,
        connectionId,
        limit: 1,
      });
      expect(page.items.map(({ workflowId }) => workflowId)).toEqual([
        publicId,
      ]);
      expect(page.nextCursor).toBeUndefined();
    } finally {
      await variables.close();
      await connections.close();
    }
  });

  it('requires target read access for a new Call site even when another site already pins that target', async () => {
    const target = {
      workflowId,
      workflowVersionId: randomUUID(),
      executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
    };
    const call = (id: string) => ({
      ...draftNode(id),
      definition: { key: 'core.call', version: 1 },
      config: { target },
    });
    const previous = { ...emptyGraph, nodes: [call('existing')] };
    const added = {
      ...emptyGraph,
      nodes: [call('existing'), call('new-site')],
    };
    const admit = (reader: string, graph = added) =>
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId: reader },
        (client) =>
          requireWorkflowCallTargets(
            client,
            { workspaceId, actorId: reader },
            graph,
            previous,
          ),
      );
    await expect(admit(builder)).rejects.toBeInstanceOf(
      InvalidWorkflowGraphError,
    );
    await expect(admit(actorId)).resolves.toBeUndefined();
    await expect(admit(builder, previous)).resolves.toBeUndefined();
  });

  it('keeps delegated private child requirements out of promotion reviews', async () => {
    const versionId = randomUUID(),
      checksum = `wf:sha256:${'a'.repeat(64)}`;
    const child = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('private-data'),
          inputMappings: {
            value: {
              kind: 'workspace_variable' as const,
              name: 'PRIVATE_CHILD_VARIABLE',
            },
          },
        },
      ],
    };
    await queryAsOwner(
      "insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by) values($1,$2,$3,2,$4::json,'{}',$5,$6)",
      [
        versionId,
        workspaceId,
        workflowId,
        JSON.stringify(child),
        checksum,
        actorId,
      ],
      workspaceId,
    );
    const graph = {
      ...emptyGraph,
      nodes: [
        {
          ...draftNode('delegated'),
          definition: { key: 'core.call', version: 1 },
          config: {
            target: {
              workflowId,
              workflowVersionId: versionId,
              executableChecksum: checksum,
            },
          },
        },
      ],
    };
    const source = {
      workflowId: publicId,
      versionId: randomUUID(),
      versionNumber: 1,
      name: 'Visible parent',
      checksum,
      graph,
    };
    const inspect = (reader: string) =>
      withTenantScopedClient(
        apiPool,
        { workspaceId, actorId: reader },
        async (client) => {
          const requirements: WorkflowPromotionRequirement[] = [];
          const resources = await readFolderScope(client, {
            workspaceId,
            actorId: reader,
          });
          await inspectPromotionCallDependencies(client, workspaceId, {
            source,
            targetWorkflowId: publicId,
            resources,
            connections: connectionScope(
              { workspaceId, actorId: reader },
              resources.role,
              'connection:use',
            ),
            graph,
            budget: new PromotionGraphBudget(),
            report: (item) => requirements.push(item),
          });
          return requirements;
        },
      );
    expect(await inspect(actorId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'PRIVATE_CHILD_VARIABLE' }),
      ]),
    );
    expect(await inspect(builder)).toEqual([]);
  });
}
