import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  actorId,
  apiUrl,
  authoring,
  createWorkflowAuthoringDatabase,
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
} from '../../../support/workflow-authoring.js';
import {
  graphWithDuration,
  createRestoreFixture,
  restoreInput,
  restoreFacts,
  insertSucceededRun,
  persistedRun,
} from './fixture.js';

export function registerCopiesExactRetainedGraphAdvances(): void {
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
    const changedCatalog = createWorkflowAuthoringDatabase(
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
}
