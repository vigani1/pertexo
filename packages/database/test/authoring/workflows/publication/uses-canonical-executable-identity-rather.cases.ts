import { expect, it } from 'vitest';

import {
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  draftNode,
  emptyGraph,
  parseDatabaseConfig,
  saveCurrentDraft,
  testDefinitionCatalog,
  workspaceId,
} from '../../../support/workflow-authoring.js';

import { recordBenchmarkOperation } from './fixture.js';

export function registerUsesCanonicalExecutableIdentityRather(): void {
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
      let operationStartedAt = performance.now();
      const created = await catalogAuthoring.createWorkflow({
        actorId,
        emptyGraph: baseGraph,
        idempotencyKey: 'create-canonical-proof',
        name: 'Canonical proof',
        workspaceId,
      });
      recordBenchmarkOperation('workflow-create', operationStartedAt);
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({ currentPublication: null });
      const initialRepresentationTag = await currentRepresentationTag(
        catalogAuthoring,
        workspaceId,
        {
          scopedWorkflowId: created.workflowId,
          scopedActorId: actorId,
          definitionCatalog: testDefinitionCatalog,
        },
      );
      operationStartedAt = performance.now();
      const first = await catalogAuthoring.publishWorkflow({
        actorId,
        representationTag: initialRepresentationTag,
        idempotencyKey: 'publish-canonical-first',
        requestHash: '1'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      recordBenchmarkOperation('workflow-publish-initial', operationStartedAt);
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
      await saveCurrentDraft(catalogAuthoring, {
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
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({
        currentPublication: {
          versionId: first.version.id,
          versionNumber: 1,
          matchesDraft: true,
        },
      });
      const presentationOnly = await catalogAuthoring.publishWorkflow({
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
        idempotencyKey: 'publish-canonical-presentation',
        requestHash: '2'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      expect(presentationOnly).toMatchObject({
        reused: true,
        version: { id: first.version.id, checksum: first.version.checksum },
      });

      await saveCurrentDraft(catalogAuthoring, {
        actorId,
        expectedRevision: 2,
        graphJson: {
          ...baseGraph,
          nodes: [draftNode('canonical', { a: 1, b: 3 })],
        },
        workflowId: created.workflowId,
        workspaceId,
      });
      const executableRepresentationTag = await currentRepresentationTag(
        catalogAuthoring,
        workspaceId,
        {
          scopedWorkflowId: created.workflowId,
          scopedActorId: actorId,
          definitionCatalog: testDefinitionCatalog,
        },
      );
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({
        currentPublication: {
          versionId: first.version.id,
          versionNumber: 1,
          matchesDraft: false,
        },
      });
      operationStartedAt = performance.now();
      const executableChange = await catalogAuthoring.publishWorkflow({
        actorId,
        representationTag: executableRepresentationTag,
        idempotencyKey: 'publish-canonical-executable',
        requestHash: '3'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      recordBenchmarkOperation('workflow-publish-change', operationStartedAt);
      expect(executableChange.reused).toBe(false);
      expect(executableChange.version.id).not.toBe(first.version.id);
      expect(executableChange.version.checksum).not.toBe(
        first.version.checksum,
      );
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({
        currentPublication: {
          versionId: executableChange.version.id,
          versionNumber: 2,
          matchesDraft: true,
        },
      });

      await saveCurrentDraft(catalogAuthoring, {
        actorId,
        expectedRevision: 3,
        graphJson: baseGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({
        currentPublication: {
          versionId: executableChange.version.id,
          versionNumber: 2,
          matchesDraft: false,
        },
      });
      const restoredPublication = await catalogAuthoring.publishWorkflow({
        actorId,
        workspaceId,
        workflowId: created.workflowId,
        representationTag: await currentRepresentationTag(
          catalogAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: testDefinitionCatalog,
          },
        ),
        idempotencyKey: 'publish-canonical-older',
        requestHash: '5'.repeat(64),
      });
      expect(restoredPublication).toMatchObject({
        reused: true,
        version: { id: first.version.id },
      });
      await expect(
        catalogAuthoring.validateDraft(
          workspaceId,
          created.workflowId,
          actorId,
        ),
      ).resolves.toMatchObject({
        currentPublication: {
          versionId: first.version.id,
          versionNumber: 1,
          matchesDraft: true,
        },
      });
      await expect(
        catalogAuthoring.listVersions({
          workspaceId,
          workflowId: created.workflowId,
          actorId,
          limit: 1,
        }),
      ).resolves.toMatchObject({ items: [{ versionNumber: 2 }] });

      await saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 4,
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
            { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
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
}
