import { describe, expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringStore,
  currentRepresentationTag,
  emptyGraph,
  otherActorId,
  otherVersionId,
  parseDatabaseConfig,
  queryAsOwner,
  randomUUID,
  testDefinitionCatalog,
  workflowDraftRepresentationTag,
  workspaceId,
  draftNode,
  draftWrite,
  failAtWrite,
  holdAtWrite,
  saveCurrentDraft,
  waitForPostgresLock,
  waitForOperationEntry,
  withApplicationName,
} from '../../support/workflow-authoring.js';
import {
  graphWithDuration,
  createRestoreFixture,
  restoreInput,
  restoreFacts,
  insertSucceededRun,
  persistedRun,
  blockedDefinitionCatalog,
  currentDefinitionCatalog,
} from './version-restore/fixture.js';

describe('workflow version restoration persistence', () => {
  it('copies the exact retained graph, advances once, audits identity, preserves history, and rejects retry', async () => {
    const fixture = await createRestoreFixture('copy-history');
    const runId = await insertSucceededRun(
      fixture.workflowId,
      fixture.secondVersionId,
    );
    const before = await restoreFacts(fixture.workflowId);
    const priorRun = await persistedRun(runId);
    const tag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: fixture.workflowId,
      scopedActorId: actorId,
    });
    const restored = await authoring.restoreWorkflowVersion({
      ...(await restoreInput(fixture, authoring, tag)),
      requestId: 'restore-request',
      traceId: 'restore-trace',
    });
    expect(restored).toMatchObject({
      graphJson: emptyGraph,
      revision: before.draft_revision + 1,
    });
    expect(await restoreFacts(fixture.workflowId)).toMatchObject({
      draft_graph: emptyGraph,
      draft_revision: before.draft_revision + 1,
      first_version_graph: emptyGraph,
      first_version_checksum: before.first_version_checksum,
      pointer: fixture.secondVersionId,
      versions: before.versions,
      outbox: before.outbox,
      publication_audits: before.publication_audits,
      restore_audits: before.restore_audits + 1,
    });
    expect(
      await queryAsOwner<{
        source_version_id: string;
        previous_revision: number;
        revision: number;
      }>(
        `select metadata->>'sourceVersionId' source_version_id,
                (metadata->>'previousRevision')::int previous_revision,
                (metadata->>'revision')::int revision
           from app.audit_events
          where target_id=$1 and action='workflow.version_restored'`,
        [fixture.workflowId],
        workspaceId,
      ),
    ).toEqual([
      {
        source_version_id: fixture.firstVersionId,
        previous_revision: before.draft_revision,
        revision: before.draft_revision + 1,
      },
    ]);
    expect(await persistedRun(runId)).toEqual(priorRun);
    await expect(
      authoring.restoreWorkflowVersion(
        await restoreInput(fixture, authoring, tag),
      ),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
    await expect(
      authoring.getDraft(workspaceId, fixture.workflowId, actorId),
    ).resolves.toMatchObject({
      revision: before.draft_revision + 1,
      graphJson: emptyGraph,
    });
  });

  it('uses the whole strong tag, including the current catalog, and keeps failure paths mutation-free', async () => {
    const fixture = await createRestoreFixture('tag');
    const draft = await authoring.getDraft(
      workspaceId,
      fixture.workflowId,
      actorId,
    );
    if (draft === null) throw new Error('Expected draft');
    const forged = workflowDraftRepresentationTag({
      workflowId: fixture.workflowId,
      revision: draft.revision,
      graph: graphWithDuration(1_000),
      compatibilityFingerprint: draft.compatibility.fingerprint,
    });
    await expect(
      authoring.restoreWorkflowVersion(
        await restoreInput(fixture, authoring, forged),
      ),
    ).rejects.toMatchObject({ currentRevision: draft.revision });
    const before = await restoreFacts(fixture.workflowId);
    const changedCatalog = createWorkflowAuthoringStore(
      parseDatabaseConfig({ connectionString: apiUrl, max: 1 }),
      { definitionCatalog: testDefinitionCatalog },
    );
    try {
      const oldTag = await currentRepresentationTag(authoring, workspaceId, {
        scopedWorkflowId: fixture.workflowId,
        scopedActorId: actorId,
      });
      await expect(
        changedCatalog.restoreWorkflowVersion(
          await restoreInput(fixture, changedCatalog, oldTag),
        ),
      ).rejects.toMatchObject({ currentRevision: draft.revision });
    } finally {
      await changedCatalog.close();
    }
    expect(await restoreFacts(fixture.workflowId)).toEqual(before);
    await expect(
      authoring.restoreWorkflowVersion({
        ...(await restoreInput(fixture)),
        representationTag: '',
      }),
    ).rejects.toBeInstanceOf(WorkflowRevisionConflictError);
    expect(await restoreFacts(fixture.workflowId)).toEqual(before);
  });

  it('enforces active author scope and source workspace/workflow identity', async () => {
    const fixture = await createRestoreFixture('scope');
    const sameWorkspace = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'restore-scope-other-workflow',
      name: 'Other restore source workflow',
      workspaceId,
    });
    const sameWorkspaceVersion = await authoring.publishWorkflow({
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: sameWorkspace.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: 'restore-scope-other-workflow-publish',
      requestHash: '3'.repeat(64),
      workflowId: sameWorkspace.workflowId,
      workspaceId,
    });
    const tag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: fixture.workflowId,
      scopedActorId: actorId,
    });
    for (const sourceVersionId of [
      sameWorkspaceVersion.version.id,
      otherVersionId,
      randomUUID(),
    ]) {
      await expect(
        authoring.restoreWorkflowVersion({
          actorId,
          representationTag: tag,
          versionId: sourceVersionId,
          workflowId: fixture.workflowId,
          workspaceId,
        }),
      ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    }
    await expect(
      authoring.restoreWorkflowVersion({
        actorId: otherActorId,
        representationTag: tag,
        versionId: fixture.firstVersionId,
        workflowId: fixture.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await authoring.transitionWorkflowLifecycle({
      actorId,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: 'restore-scope-archive',
      workflowId: fixture.workflowId,
      workspaceId,
    });
    await expect(
      authoring.restoreWorkflowVersion({
        actorId,
        representationTag: tag,
        versionId: fixture.firstVersionId,
        workflowId: fixture.workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

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

  it('restores a fresh tag for an identical graph', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'restore-identical-create',
      name: 'Restore identical',
      workspaceId,
    });
    const version = await authoring.publishWorkflow({
      actorId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: 'restore-identical-publish',
      requestHash: '4'.repeat(64),
      workflowId: created.workflowId,
      workspaceId,
    });
    const tag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    });
    await expect(
      authoring.restoreWorkflowVersion({
        actorId,
        representationTag: tag,
        versionId: version.version.id,
        workflowId: created.workflowId,
        workspaceId,
      }),
    ).resolves.toMatchObject({ revision: 2, graphJson: emptyGraph });
  });
});
