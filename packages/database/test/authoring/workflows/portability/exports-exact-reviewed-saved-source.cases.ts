import { expect, it } from 'vitest';
import {
  parseWorkflowGraphDraft,
  portableGraphDigest,
} from '@pertexo/workflow-model';

import { WorkflowPortabilityReviewConflictError } from '../../../../src/authoring/workflows/errors.js';

import {
  actorId,
  otherActorId,
  workspaceId,
  otherVersionId,
  currentRepresentationTag,
  emptyGraph,
  randomUUID,
  authoring,
  WorkflowNotFoundError,
  WorkflowRevisionConflictError,
  saveCurrentDraft,
} from '../../../support/workflow-authoring.js';
import { database, command } from './fixture.js';

export function registerExportsExactReviewedSavedSource(): void {
  it('exports only the exact reviewed saved source; source changes require a new acknowledgement', async () => {
    const db = database();
    const created = await db.createWorkflow({
      workspaceId,
      actorId,
      name: 'Reviewed export',
      emptyGraph,
      idempotencyKey: randomUUID(),
    });
    const input = {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      source: { kind: 'draft' as const },
      reviewedGraphDigest: await portableGraphDigest(
        parseWorkflowGraphDraft(emptyGraph),
      ),
      representationTag: await currentRepresentationTag(db, workspaceId, {
        scopedWorkflowId: created.workflowId,
        scopedActorId: actorId,
      }),
    };
    expect(await db.exportWorkflow(input)).toEqual(command().manifest);
    const publication = await authoring.publishWorkflow({
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: created.workflowId, scopedActorId: actorId },
      ),
      requestHash: 'f'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(
      await db.exportWorkflow({
        ...input,
        source: { kind: 'version', versionId: publication.version.id },
      }),
    ).toEqual(command().manifest);
    await expect(
      db.exportWorkflow({ ...input, reviewedGraphDigest: '0'.repeat(64) }),
    ).rejects.toBeInstanceOf(WorkflowPortabilityReviewConflictError);
    await saveCurrentDraft(db, {
      workspaceId,
      actorId,
      workflowId: created.workflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 1000 } },
    });
    await expect(db.exportWorkflow(input)).rejects.toBeInstanceOf(
      WorkflowRevisionConflictError,
    );
    await expect(
      db.exportWorkflow({
        ...input,
        source: { kind: 'version', versionId: otherVersionId },
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await expect(
      db.exportWorkflow({ ...input, actorId: otherActorId }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
}
