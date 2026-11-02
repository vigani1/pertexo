import { expect, it } from 'vitest';
import {
  WorkflowRevisionConflictError,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  draftNode,
  draftWrite,
  emptyGraph,
  failAtWrite,
  holdAtWrite,
  parseDatabaseConfig,
  randomUUID,
  saveCurrentDraft,
  waitForPostgresLock,
  waitForOperationEntry,
  workspaceId,
  withApplicationName,
} from '../../../support/workflow-authoring.js';
import {
  graphWithDuration,
  blockedDefinitionCatalog,
  currentDefinitionCatalog,
  createRestoreFixture,
  restoreInput,
  restoreFacts,
} from './fixture.js';

export function registerAppliesExistingPlaceabilityRuleRetained(): void {
  it('applies the existing placeability rule to retained graphs', async () => {
    const sourceAuthoring = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: blockedDefinitionCatalog,
      },
    );
    const rejectingAuthoring = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      {
        definitionCatalog: currentDefinitionCatalog,
      },
    );
    try {
      const created = await sourceAuthoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: 'restore-blocked-create',
        name: 'Restore blocked definition',
        workspaceId,
      });
      const blockedGraph = {
        ...emptyGraph,
        nodes: [
          {
            ...draftNode('blocked'),
            definition: { key: 'test.blocked', version: 1 },
          },
        ],
      };
      await saveCurrentDraft(sourceAuthoring, {
        actorId,
        expectedRevision: 1,
        graphJson: blockedGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      const blockedVersion = await sourceAuthoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          sourceAuthoring,
          workspaceId,
          {
            scopedWorkflowId: created.workflowId,
            scopedActorId: actorId,
            definitionCatalog: blockedDefinitionCatalog,
          },
        ),
        idempotencyKey: 'restore-blocked-publish',
        requestHash: '5'.repeat(64),
        workflowId: created.workflowId,
        workspaceId,
      });
      await saveCurrentDraft(sourceAuthoring, {
        actorId,
        expectedRevision: 2,
        graphJson: emptyGraph,
        workflowId: created.workflowId,
        workspaceId,
      });
      const before = await restoreFacts(created.workflowId);
      await expect(
        rejectingAuthoring.restoreWorkflowVersion({
          actorId,
          representationTag: await currentRepresentationTag(
            rejectingAuthoring,
            workspaceId,
            {
              scopedWorkflowId: created.workflowId,
              scopedActorId: actorId,
              definitionCatalog: currentDefinitionCatalog,
            },
          ),
          versionId: blockedVersion.version.id,
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).rejects.toThrow('Workflow draft adds a definition');
      expect(await restoreFacts(created.workflowId)).toEqual(before);
    } finally {
      await Promise.all([sourceAuthoring.close(), rejectingAuthoring.close()]);
    }
  });

  it('rolls back draft and audit failures as one transaction', async () => {
    for (const step of ['draft', 'audit'] as const) {
      const fixture = await createRestoreFixture(`rollback-${step}`);
      const before = await restoreFacts(fixture.workflowId);
      const fault = await failAtWrite(
        step === 'draft'
          ? draftWrite(fixture.workflowId)
          : {
              table: 'audit_events',
              operation: 'insert',
              when: `NEW.target_id = '${fixture.workflowId}' and NEW.action = 'workflow.version_restored'`,
            },
      );
      try {
        await expect(
          authoring.restoreWorkflowVersion(await restoreInput(fixture)),
        ).rejects.toThrow(fault.message);
      } finally {
        await fault.remove();
      }
      expect(await restoreFacts(fixture.workflowId)).toEqual(before);
      await expect(
        authoring.restoreWorkflowVersion(await restoreInput(fixture)),
      ).resolves.toMatchObject({ revision: before.draft_revision + 1 });
    }
  });

  it('serializes save-first and restore-first races on the workflow and draft rows', async () => {
    const restoreFirstFixture =
      await createRestoreFixture('race-restore-first');
    const restoreHold = await holdAtWrite(
      draftWrite(restoreFirstFixture.workflowId),
    );
    const restoreApplication = `restore-first-${randomUUID()}`;
    const saveApplication = `save-after-restore-${randomUUID()}`;
    const restoreFirst = createWorkflowAuthoringStore(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, restoreApplication),
        max: 1,
      }),
    );
    const saveAfterRestore = createWorkflowAuthoringStore(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, saveApplication),
        max: 1,
      }),
    );
    try {
      const tag = await currentRepresentationTag(authoring, workspaceId, {
        scopedWorkflowId: restoreFirstFixture.workflowId,
        scopedActorId: actorId,
      });
      const restore = restoreFirst.restoreWorkflowVersion(
        await restoreInput(restoreFirstFixture, restoreFirst, tag),
      );
      await waitForOperationEntry(
        restoreHold.reached(),
        restore,
        'restore-first command',
      );
      const save = saveCurrentDraft(saveAfterRestore, {
        actorId,
        expectedRevision: 3,
        graphJson: graphWithDuration(3_000),
        workflowId: restoreFirstFixture.workflowId,
        workspaceId,
      });
      const saveExpectation = expect(save).rejects.toBeInstanceOf(
        WorkflowRevisionConflictError,
      );
      await waitForPostgresLock(saveApplication);
      await restoreHold.release();
      await expect(restore).resolves.toMatchObject({
        revision: 4,
        graphJson: emptyGraph,
      });
      await saveExpectation;
    } finally {
      await restoreHold.release();
      await Promise.all([restoreFirst.close(), saveAfterRestore.close()]);
      await restoreHold.remove();
    }

    const saveFirstFixture = await createRestoreFixture('race-save-first');
    const saveHold = await holdAtWrite(draftWrite(saveFirstFixture.workflowId));
    const saveFirstApplication = `save-first-${randomUUID()}`;
    const restoreAfterSaveApplication = `restore-after-save-${randomUUID()}`;
    const saveFirst = createWorkflowAuthoringStore(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, saveFirstApplication),
        max: 1,
      }),
    );
    const restoreAfterSave = createWorkflowAuthoringStore(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          restoreAfterSaveApplication,
        ),
        max: 1,
      }),
    );
    try {
      const tag = await currentRepresentationTag(authoring, workspaceId, {
        scopedWorkflowId: saveFirstFixture.workflowId,
        scopedActorId: actorId,
      });
      const save = saveCurrentDraft(saveFirst, {
        actorId,
        expectedRevision: 3,
        graphJson: graphWithDuration(3_000),
        workflowId: saveFirstFixture.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        saveHold.reached(),
        save,
        'save-first command',
      );
      const restore = restoreAfterSave.restoreWorkflowVersion(
        await restoreInput(saveFirstFixture, restoreAfterSave, tag),
      );
      const restoreExpectation = expect(restore).rejects.toMatchObject({
        currentRevision: 4,
      });
      await waitForPostgresLock(restoreAfterSaveApplication);
      await saveHold.release();
      await expect(save).resolves.toMatchObject({ revision: 4 });
      await restoreExpectation;
    } finally {
      await saveHold.release();
      await Promise.all([saveFirst.close(), restoreAfterSave.close()]);
      await saveHold.remove();
    }
  });
}
