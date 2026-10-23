import { expect, it } from 'vitest';
import type { WorkflowGraph, WorkflowNote } from '@pertexo/workflow-model';
import {
  actorId,
  authoring,
  emptyGraph,
  workspaceId,
  randomUUID,
  currentRepresentationTag,
  saveCurrentDraft,
} from '../../support/workflow-authoring.js';

const note: WorkflowNote = {
  id: '00000000-0000-4000-8000-000000000001',
  text: '## Reviewed instructions',
  position: { x: 40, y: -80 },
  size: { width: 320, height: 200 },
  color: 'amber',
};

it('publishes immutable documentation versions with one executable identity, then restores and duplicates notes', async () => {
  const created = await authoring.createWorkflow({
    actorId,
    workspaceId,
    emptyGraph,
    name: 'Documented workflow',
    idempotencyKey: randomUUID(),
  });
  const workflowId = created.workflowId;
  const publish = async () =>
    authoring.publishWorkflow({
      actorId,
      workspaceId,
      workflowId,
      representationTag: await currentRepresentationTag(
        authoring,
        workspaceId,
        { scopedWorkflowId: workflowId, scopedActorId: actorId },
      ),
      idempotencyKey: randomUUID(),
      requestHash: 'a'.repeat(64),
    });
  const first = await publish();
  const documented: WorkflowGraph = { ...emptyGraph, notes: [note] };
  await saveCurrentDraft(authoring, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 1,
    graphJson: documented,
  });
  expect(
    (await authoring.validateDraft(workspaceId, workflowId, actorId))
      ?.currentPublication?.matchesDraft,
  ).toBe(false);
  const second = await publish();
  expect(second.reused).toBe(false);
  expect(second.version.id).not.toBe(first.version.id);
  expect(second.version.checksum).toBe(first.version.checksum);
  const kept = await authoring.getVersion(
    workspaceId,
    workflowId,
    second.version.id,
    actorId,
  );
  expect(kept?.graphJson.notes).toEqual([note]);
  expect(
    (
      await authoring.getVersion(
        workspaceId,
        workflowId,
        first.version.id,
        actorId,
      )
    )?.graphJson.notes,
  ).toBeUndefined();
  expect(
    (await authoring.validateDraft(workspaceId, workflowId, actorId))
      ?.currentPublication?.matchesDraft,
  ).toBe(true);
  expect((await publish()).reused).toBe(true);
  const copy = await authoring.duplicateWorkflow({
    actorId,
    workspaceId,
    workflowId,
    name: 'Documented copy',
    source: { kind: 'draft' },
    representationTag: await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: workflowId,
      scopedActorId: actorId,
    }),
    idempotencyKey: randomUUID(),
  });
  expect(
    (await authoring.getDraft(workspaceId, copy.workflowId, actorId))?.graphJson
      .notes,
  ).toEqual([note]);
  await saveCurrentDraft(authoring, {
    actorId,
    workspaceId,
    workflowId,
    expectedRevision: 2,
    graphJson: {
      ...documented,
      notes: [{ ...note, text: 'Changed after review' }],
    },
  });
  await authoring.restoreWorkflowVersion({
    actorId,
    workspaceId,
    workflowId,
    versionId: second.version.id,
    representationTag: await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: workflowId,
      scopedActorId: actorId,
    }),
  });
  expect(
    (await authoring.getDraft(workspaceId, workflowId, actorId))?.graphJson
      .notes,
  ).toEqual([note]);
  expect((await publish()).version.id).toBe(second.version.id);
});
