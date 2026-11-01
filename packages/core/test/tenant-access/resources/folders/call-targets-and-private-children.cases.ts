import { connectionScope } from '../../../../src/tenant-access/resources/connections/scope.js';
import { inspectPromotionCallDependencies } from '../../../../src/authoring/promotion/preparation/calls.queries.js';
import { PromotionGraphBudget } from '../../../../src/authoring/promotion/preparation/graph.js';
import { readFolderScope } from '../../../../src/shared/facts.queries.js';
import type { WorkflowPromotionRequirement } from '@pertexo/contracts';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { requireWorkflowCallTargets } from '../../../../src/tenant-access/resources/bindings.queries.js';

import { withTenantScopedClient } from '@pertexo/database/primitives';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  actorId,
  apiPool,
  emptyGraph,
  draftNode,
  queryAsOwner,
  workspaceId,
  workflowId,
} from '../../../support/workflow-authoring.js';

import { builder, publicId } from './fixture.js';

export function registerCallTargetsAndPrivateChildren(): void {
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
