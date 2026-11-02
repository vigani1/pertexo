import { expect, it } from 'vitest';

import {
  actorId,
  apiUrl,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  emptyGraph,
  parseDatabaseConfig,
  baselineEmptyDefinitionCatalog,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { ZodError } from 'zod';

export function registerAtomicallyPersistsInjectedExecutablePublication(): void {
  it('atomically persists an injected executable publication projection', async () => {
    const checksum = `wf:sha256:${'a'.repeat(64)}` as const;
    const executableDefinitionCatalog = baselineEmptyDefinitionCatalog;
    const executableJson = {
      marker: 'compiled-in-api',
    };
    const executableAuthoring = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: executableDefinitionCatalog,
        executableCompiler: () => ({
          checksum,
          executableJson,
        }),
      },
    );
    try {
      const created = await executableAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'create-v2-publication-proof',
        name: 'Publication proof',
        workspaceId,
      });
      const representationTag = await currentRepresentationTag(
        executableAuthoring,
        workspaceId,
        {
          scopedWorkflowId: created.workflowId,
          scopedActorId: actorId,
          definitionCatalog: executableDefinitionCatalog,
        },
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
          `select checksum, executable_json
             from app.workflow_versions
            where workspace_id = $1 and id = $2`,
          [workspaceId, published.version.id],
          workspaceId,
        ),
      ).resolves.toEqual([
        {
          checksum,
          executable_json: executableJson,
        },
      ]);

      const drifted = createWorkflowAuthoringStore(
        parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
        {
          definitionCatalog: {
            definitions: [{ key: 'test.drifted', version: 1 }],
          },
          executableCompiler: () => ({
            checksum,
            executableJson,
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
        ).rejects.toThrow('Workflow draft revision does not match');
      } finally {
        await drifted.close();
      }

      await queryAsOwner(
        `insert into app.workflow_versions
           (id,workspace_id,workflow_id,version_number,
            graph_json,checksum,executable_json,published_by)
         values($1,$2,$3,2,'{}'::jsonb,$4,$5::jsonb,$6)
         returning id`,
        [
          randomUUID(),
          workspaceId,
          created.workflowId,
          `wf:sha256:${'b'.repeat(64)}`,
          JSON.stringify(executableJson),
          actorId,
        ],
        workspaceId,
      );
      await expect(
        executableAuthoring.publishWorkflow({
          ...command,
          idempotencyKey: 'publish-v2-corrupt-retained-graph',
          requestHash: 'a'.repeat(64),
        }),
      ).resolves.toMatchObject({
        reused: true,
        replayed: false,
        version: { id: published.version.id },
      });
      await expect(
        queryAsOwner<{ versions: string }>(
          `select count(*)::text versions from app.workflow_versions
            where workspace_id=$1 and workflow_id=$2`,
          [workspaceId, created.workflowId],
          workspaceId,
        ),
      ).resolves.toEqual([{ versions: '2' }]);
      // Matching candidates still cross the retained-graph integrity boundary.
      await queryAsOwner(
        `insert into app.workflow_versions
           (id,workspace_id,workflow_id,version_number,
            graph_json,checksum,executable_json,published_by)
         values($1,$2,$3,3,'{}'::json,$4,$5::json,$6)`,
        [
          randomUUID(),
          workspaceId,
          created.workflowId,
          checksum,
          JSON.stringify(executableJson),
          actorId,
        ],
        workspaceId,
      );
      await expect(
        executableAuthoring.publishWorkflow({
          ...command,
          idempotencyKey: 'publish-v2-corrupt-matching-graph',
          requestHash: 'b'.repeat(64),
        }),
      ).rejects.toBeInstanceOf(ZodError);
      await expect(
        queryAsOwner<{ versions: string }>(
          `select count(*)::text versions from app.workflow_versions
          where workspace_id=$1 and workflow_id=$2`,
          [workspaceId, created.workflowId],
          workspaceId,
        ),
      ).resolves.toEqual([{ versions: '3' }]);
    } finally {
      await executableAuthoring.close();
    }
  });
}
