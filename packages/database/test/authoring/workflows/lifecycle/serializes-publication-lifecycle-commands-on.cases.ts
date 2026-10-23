import { expect, it } from 'vitest';
import {
  actorId,
  apiUrl,
  archiveWrite,
  authoring,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  holdAtWrite,
  parseDatabaseConfig,
  publicationWrite,
  randomUUID,
  waitForPostgresLock,
  waitForOperationEntry,
  withApplicationName,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { lifecycleFacts } from './fixture.js';

export function registerSerializesPublicationLifecycleCommandsOn(): void {
  it('serializes publication and lifecycle commands on the workflow row', async () => {
    const archiveFirst = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'lifecycle-archive-first-create',
      name: 'Lifecycle archive first',
      workspaceId,
    });
    const archiveHold = await holdAtWrite(
      archiveWrite('workflow', archiveFirst.workflowId),
    );
    const archiveApplication = `laf-${randomUUID()}`;
    const archiveFirstCommand = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, archiveApplication),
        max: 1,
      }),
    );
    const archiveFirstPublisherApplication = `lafp-${randomUUID()}`;
    const archiveFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          archiveFirstPublisherApplication,
        ),
        max: 1,
      }),
    );
    try {
      const archive = archiveFirstCommand.transitionWorkflowLifecycle({
        actorId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: 'lifecycle-archive-first-archive',
        workflowId: archiveFirst.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        archiveHold.reached(),
        archive,
        'archive-first lifecycle command',
      );
      // Publishing may reject before the archive's assertion is awaited.
      const publish = Promise.allSettled([
        archiveFirstPublisher.publishWorkflow({
          actorId,
          representationTag: await currentRepresentationTag(
            authoring,
            workspaceId,
            {
              scopedWorkflowId: archiveFirst.workflowId,
              scopedActorId: actorId,
            },
          ),
          idempotencyKey: 'lifecycle-archive-first-publish',
          requestHash: 'a'.repeat(64),
          workflowId: archiveFirst.workflowId,
          workspaceId,
        }),
      ]);
      await waitForPostgresLock(archiveFirstPublisherApplication);
      await archiveHold.release();
      await expect(archive).resolves.toMatchObject({
        workflow: { lifecycleStatus: 'archived', publishedVersionId: null },
      });
      expect(await publish).toMatchObject([
        { status: 'rejected', reason: { name: 'WorkflowNotFoundError' } },
      ]);
      expect(await lifecycleFacts(archiveFirst.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        publishedVersionId: null,
        idempotencyClaims: 1,
        reconciliationOutbox: 0,
        auditEvents: 1,
      });
    } finally {
      await archiveHold.release();
      await Promise.all([
        archiveFirstCommand.close(),
        archiveFirstPublisher.close(),
      ]);
      await archiveHold.remove();
    }

    const publicationFirst = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'lifecycle-publication-first-create',
      name: 'Lifecycle publication first',
      workspaceId,
    });
    const publishHold = await holdAtWrite(
      publicationWrite('version', publicationFirst.workflowId),
    );
    const publicationFirstApplication = `lpf-${randomUUID()}`;
    const publicationFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publicationFirstApplication,
        ),
        max: 1,
      }),
    );
    const publicationFirstArchiveApplication = `lpfa-${randomUUID()}`;
    const publicationFirstArchive = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publicationFirstArchiveApplication,
        ),
        max: 1,
      }),
    );
    try {
      const publish = publicationFirstPublisher.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          {
            scopedWorkflowId: publicationFirst.workflowId,
            scopedActorId: actorId,
          },
        ),
        idempotencyKey: 'lifecycle-publication-first-publish',
        requestHash: 'b'.repeat(64),
        workflowId: publicationFirst.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        publishHold.reached(),
        publish,
        'publication-first command',
      );
      const archive = publicationFirstArchive.transitionWorkflowLifecycle({
        actorId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: 'lifecycle-publication-first-archive',
        workflowId: publicationFirst.workflowId,
        workspaceId,
      });
      await waitForPostgresLock(publicationFirstArchiveApplication);
      await publishHold.release();
      const publication = await publish;
      expect(publication).toMatchObject({
        version: { workflowId: publicationFirst.workflowId },
      });
      const archived = await archive;
      expect(archived).toMatchObject({
        workflow: {
          lifecycleStatus: 'archived',
          lifecycleRevision: 2,
        },
      });
      expect(archived.workflow.publishedVersionId).toBe(publication.version.id);
      expect(await lifecycleFacts(publicationFirst.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        idempotencyClaims: 1,
        reconciliationOutbox: 2,
        auditEvents: 1,
      });
    } finally {
      await publishHold.release();
      await Promise.all([
        publicationFirstPublisher.close(),
        publicationFirstArchive.close(),
      ]);
      await publishHold.remove();
    }
  });
}
