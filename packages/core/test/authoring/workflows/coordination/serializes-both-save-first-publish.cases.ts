import { expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  finishControlledScenario,
  holdAtWrite,
  parseDatabaseConfig,
  publicationWrite,
  saveCurrentDraft,
  workflowId,
  workspaceId,
  waitForPostgresLock,
  waitForOperationEntry,
  withApplicationName,
} from '../../../support/workflow-authoring.js';

export function registerSerializesBothSaveFirstPublish(): void {
  it('serializes both save-first and publish-first lock orders without graph skew', async () => {
    const saveFirstPublisherApplication = `workflow-save-first-${workflowId}`;
    const saveFirstDraft = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-save-first-race',
      name: 'Save first race',
      workspaceId,
    });
    const saveHold = await holdAtWrite({
      table: 'workflow_drafts',
      operation: 'update',
      when: `NEW.workflow_id = '${saveFirstDraft.workflowId}'`,
    });
    const saveFirstTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      { scopedWorkflowId: saveFirstDraft.workflowId, scopedActorId: actorId },
    );
    const saveFirstDatabase = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const saveFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          saveFirstPublisherApplication,
        ),
        max: 1,
      }),
    );
    let save: Promise<unknown> | undefined;
    let publish: Promise<unknown> | undefined;
    let primaryError: unknown;
    try {
      save = saveCurrentDraft(saveFirstDatabase, {
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 3_000 },
        },
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(saveHold.reached(), save, 'save-first save');
      publish = saveFirstPublisher.publishWorkflow({
        actorId,
        representationTag: saveFirstTag,
        idempotencyKey: 'publish-save-first-race',
        requestHash: '5'.repeat(64),
        workflowId: saveFirstDraft.workflowId,
        workspaceId,
      });
      const publishExpectation = expect(publish).rejects.toMatchObject({
        currentRevision: 2,
      });
      await waitForPostgresLock(saveFirstPublisherApplication);
      await saveHold.release();
      await expect(save).resolves.toMatchObject({ revision: 2 });
      await publishExpectation;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishControlledScenario({
      close: [
        () => saveFirstDatabase.close(),
        () => saveFirstPublisher.close(),
        () => saveHold.remove(),
      ],
      label: 'save-first authoring race',
      operations: [save, publish],
      primaryError,
      release: () => void saveHold.release(),
    });

    const publishFirstDraft = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-publish-first-race',
      name: 'Publish first race',
      workspaceId,
    });
    const publishHold = await holdAtWrite(
      publicationWrite('version', publishFirstDraft.workflowId),
    );
    const publishFirstTag = await currentRepresentationTag(
      authoring,
      workspaceId,
      {
        scopedWorkflowId: publishFirstDraft.workflowId,
        scopedActorId: actorId,
      },
    );
    const publishFirstDatabase = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    );
    const publishFirstSaverApplication = `workflow-publish-first-${workflowId}`;
    const publishFirstSaver = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publishFirstSaverApplication,
        ),
        max: 1,
      }),
    );
    let publishFirstOperation: Promise<unknown> | undefined;
    let saveAfterPublish: Promise<unknown> | undefined;
    primaryError = undefined;
    try {
      publishFirstOperation = publishFirstDatabase.publishWorkflow({
        actorId,
        representationTag: publishFirstTag,
        idempotencyKey: 'publish-publish-first-race',
        requestHash: '7'.repeat(64),
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        publishHold.reached(),
        publishFirstOperation,
        'publish-first publication',
      );
      saveAfterPublish = saveCurrentDraft(publishFirstSaver, {
        actorId,
        expectedRevision: 1,
        graphJson: {
          ...emptyGraph,
          settings: { maxRunDurationMs: 4_000 },
        },
        workflowId: publishFirstDraft.workflowId,
        workspaceId,
      });
      const saveExpectation = expect(saveAfterPublish).resolves.toMatchObject({
        revision: 2,
      });
      await waitForPostgresLock(publishFirstSaverApplication);
      await publishHold.release();
      await expect(publishFirstOperation).resolves.toMatchObject({
        version: { graphJson: emptyGraph },
      });
      await saveExpectation;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishControlledScenario({
      close: [
        () => publishFirstDatabase.close(),
        () => publishFirstSaver.close(),
        () => publishHold.remove(),
      ],
      label: 'publish-first authoring race',
      operations: [publishFirstOperation, saveAfterPublish],
      primaryError,
      release: () => void publishHold.release(),
    });
  });
}
