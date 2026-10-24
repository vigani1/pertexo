import { expect, it } from 'vitest';
import { InvalidWorkflowGraphError } from '@pertexo/workflow-model';
import { createWorkflowAuthoringDatabase as createUnwiredAuthoringDatabase } from '../../../../src/authoring/workflows/repository.js';
import {
  actorId,
  apiUrl,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  testDefinitionCatalog,
  WorkflowNotFoundError,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { testExecutableCompiler } from '../../../../src/authoring/test-executable-compiler.js';

export function registerRejectsMalformedNewAdmissionWithout(): void {
  it('rejects malformed new admission without durable effects while replay and 412 precede unavailable parsing', async () => {
    const catalogAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    const unavailableAuthoring = createUnwiredAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { executableCompiler: testExecutableCompiler },
    );
    try {
      const created = await catalogAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        workspaceId,
        name: 'Admission ordering',
        idempotencyKey: `admission-create-${randomUUID()}`,
      });
      const originalTag = await currentRepresentationTag(
        catalogAuthoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      );
      const original = {
        actorId,
        workspaceId,
        workflowId: created.workflowId,
        representationTag: originalTag,
        idempotencyKey: `admission-publish-${randomUUID()}`,
        requestHash: createHash('sha256').update(originalTag).digest('hex'),
      };
      const accepted = await catalogAuthoring.publishWorkflow(original);
      const malformedGraph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('expression'),
            inputMappings: {
              value: {
                kind: 'expression',
                language: 'jsonata',
                expression: '(',
              },
            },
          },
        ],
      };
      await catalogAuthoring.saveDraft({
        actorId,
        workspaceId,
        workflowId: created.workflowId,
        expectedRevision: 1,
        representationTag: originalTag,
        graphJson: malformedGraph,
      });
      const checked = await catalogAuthoring.validateDraft(
        workspaceId,
        created.workflowId,
        actorId,
      );
      expect(checked?.validation).toMatchObject({
        ok: false,
        issues: [
          {
            code: 'invalid_expression',
            path: '$.nodes.expression.inputMappings.value',
          },
        ],
      });
      const currentTag = await currentRepresentationTag(
        catalogAuthoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      );
      await expect(
        catalogAuthoring.publishWorkflow({
          ...original,
          representationTag: currentTag,
          idempotencyKey: 'new-malformed-admission',
          requestHash: createHash('sha256').update(currentTag).digest('hex'),
        }),
      ).rejects.toBeInstanceOf(InvalidWorkflowGraphError);
      await expect(
        unavailableAuthoring.publishWorkflow(original),
      ).resolves.toMatchObject({
        replayed: true,
        version: { id: accepted.version.id },
      });
      await expect(
        unavailableAuthoring.publishWorkflow({
          ...original,
          requestHash: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
      await expect(
        unavailableAuthoring.publishWorkflow({
          ...original,
          idempotencyKey: 'stale-before-unavailable',
        }),
      ).rejects.toMatchObject({ name: 'WorkflowRevisionConflictError' });
      const unavailableTag = await currentRepresentationTag(
        unavailableAuthoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      );
      await expect(
        unavailableAuthoring.publishWorkflow({
          ...original,
          representationTag: unavailableTag,
          idempotencyKey: 'unwired-new-admission',
          requestHash: createHash('sha256')
            .update(unavailableTag)
            .digest('hex'),
        }),
      ).rejects.toMatchObject({ reason: 'not_configured' });
      const durable = await queryAsOwner(
        `select
        (select count(*)::int from app.workflow_versions where workflow_id=$1) versions,
        (select count(*)::int from app.audit_events where target_id=$1 and action='workflow.published') audits,
        (select count(*)::int from app.idempotency_records where resource_id=$1 and operation='workflow.publish') receipts`,
        [created.workflowId],
        workspaceId,
      );
      expect(durable).toEqual([{ versions: 1, audits: 1, receipts: 1 }]);
    } finally {
      await Promise.all([
        catalogAuthoring.close(),
        unavailableAuthoring.close(),
      ]);
    }
  });

  it('fails closed when a stored publication names a version this workflow does not have', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-corrupt-publish',
      name: 'Corrupt publish',
      workspaceId,
    });
    const idempotencyKey = 'publish-corrupt-result';
    const command = {
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey,
      requestHash: createHash('sha256').update(idempotencyKey).digest('hex'),
      workflowId: created.workflowId,
      workspaceId,
    } as const;
    await expect(authoring.publishWorkflow(command)).resolves.toMatchObject({
      replayed: false,
    });
    await queryAsOwner(
      `update app.idempotency_records
          set result_ref=jsonb_set(result_ref,'{versionId}',to_jsonb($2::text),false)
        where workspace_id=$3 and operation='workflow.publish' and key_hash=$1
        returning key_hash`,
      [
        createHash('sha256').update(idempotencyKey).digest('hex'),
        randomUUID(),
        workspaceId,
      ],
      workspaceId,
    );
    await expect(authoring.publishWorkflow(command)).rejects.toBeInstanceOf(
      WorkflowNotFoundError,
    );
  });

  it('publishes and replays a graph larger than a stored command result', async () => {
    const catalogAuthoring = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    try {
      const graph = {
        ...emptyGraph,
        nodes: Array.from({ length: 24 }, (_, index) =>
          draftNode(`large-${String(index)}`, { note: 'x'.repeat(256) }),
        ),
      };
      expect(JSON.stringify(graph).length).toBeGreaterThan(4096);
      const created = await catalogAuthoring.createWorkflow({
        actorId,
        emptyGraph: graph,
        idempotencyKey: 'create-large-publication',
        name: 'Large publication',
        workspaceId,
      });
      const command = {
        actorId,
        representationTag: await currentRepresentationTag(
          catalogAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: testDefinitionCatalog,
          },
        ),
        idempotencyKey: 'publish-large',
        requestHash: '7'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      };
      const published = await catalogAuthoring.publishWorkflow(command);
      expect(published).toMatchObject({ replayed: false, reused: false });
      expect(published.version.graphJson).toEqual(graph);
      await expect(catalogAuthoring.publishWorkflow(command)).resolves.toEqual({
        ...published,
        replayed: true,
      });
    } finally {
      await catalogAuthoring.close();
    }
  });
}
