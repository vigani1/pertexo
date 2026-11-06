import { expect, it } from 'vitest';
import { WorkflowEngineError } from '@pertexo/workflow-engine/server';
import { testExecutableCompiler } from '../../../src/authoring/test-executable-compiler.js';
import {
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  workspaceId,
} from '../../support/workflow-authoring.js';

it('checks a valid unpublished saved draft without making a version', async () => {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    name: 'Unpublished check',
    emptyGraph,
    idempotencyKey: randomUUID(),
  });
  expect(
    await authoring.validateDraft(workspaceId, created.workflowId, actorId),
  ).toMatchObject({
    draft: { revision: 1 },
    validation: { ok: true },
    currentPublication: null,
  });
  expect(
    await authoring.listVersions({
      workspaceId,
      workflowId: created.workflowId,
      actorId,
      limit: 10,
    }),
  ).toMatchObject({ items: [] });
});

it.each(['changed identity', 'refused', 'unavailable'] as const)(
  'checks the retained publication when the external compiler is %s',
  async (kind) => {
    const created = await authoring.createWorkflow({
      actorId,
      workspaceId,
      name: 'Compiler comparison',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const published = await authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
    expect(
      (await authoring.validateDraft(workspaceId, created.workflowId, actorId))
        ?.currentPublication,
    ).toMatchObject({ versionId: published.version.id, matchesDraft: true });
    const checker = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        executableCompiler: (graph) => {
          if (kind === 'refused')
            throw new WorkflowEngineError(
              'executable_invalid',
              'Switch config is invalid',
            );
          if (kind === 'unavailable')
            throw new Error('The executable catalog is unavailable');
          return {
            ...testExecutableCompiler(graph),
            checksum: `wf:sha256:${'f'.repeat(64)}`,
          };
        },
      },
    );
    try {
      const checking = checker.validateDraft(
        workspaceId,
        created.workflowId,
        actorId,
      );
      if (kind === 'unavailable') {
        await expect(checking).rejects.toThrow(
          'The executable catalog is unavailable',
        );
      } else {
        const result = await checking;
        expect(result).toMatchObject({
          draft: { revision: 1 },
          validation:
            kind === 'refused'
              ? {
                  ok: false,
                  issues: [
                    {
                      code: 'invalid_graph',
                      message: 'Switch config is invalid',
                    },
                  ],
                }
              : { ok: true },
          currentPublication: {
            versionId: published.version.id,
            versionNumber: 1,
            matchesDraft: false,
          },
        });
      }
      const durable = await queryAsOwner(
        `select
      (select count(*)::int from app.workflow_versions where workflow_id=$1) versions,
      (select revision from app.workflow_drafts where workflow_id=$1) revision,
      published_version_id from app.workflows where id=$1`,
        [created.workflowId],
        workspaceId,
      );
      expect(durable).toEqual([
        {
          versions: 1,
          revision: 1,
          published_version_id: published.version.id,
        },
      ]);
    } finally {
      await checker.close();
    }
  },
);
