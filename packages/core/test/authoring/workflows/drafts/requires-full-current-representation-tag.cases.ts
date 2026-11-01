import { expect, it } from 'vitest';
import {
  WorkflowNotFoundError,
  actorId,
  authoring,
  currentRepresentationTag,
  emptyGraph,
  otherWorkflowId,
  saveCurrentDraft,
  workspaceId,
} from '../../../support/workflow-authoring.js';

export function registerRequiresFullCurrentRepresentationTag(): void {
  it('requires the full current representation tag while revision CAS remains authoritative', async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-save-tag-authority',
      name: 'Save tag authority',
      workspaceId,
    });
    const input = {
      actorId,
      expectedRevision: 1,
      graphJson: emptyGraph,
      workflowId: created.workflowId,
      workspaceId,
    } as const;
    const currentTag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    });

    const wrongTag = `"draft.${'A'.repeat(43)}"`;
    await expect(
      authoring.saveDraft({ ...input, representationTag: wrongTag }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkflowRevisionConflictError',
        currentRevision: 1,
        currentEtag: currentTag,
      }),
    );
    await expect(
      authoring.getDraft(workspaceId, created.workflowId, actorId),
    ).resolves.toMatchObject({ revision: 1 });

    const saved = await authoring.saveDraft({
      ...input,
      representationTag: currentTag,
    });
    expect(saved.revision).toBe(2);
    const savedTag = await currentRepresentationTag(authoring, workspaceId, {
      scopedWorkflowId: created.workflowId,
      scopedActorId: actorId,
    });
    await expect(
      authoring.saveDraft({ ...input, representationTag: currentTag }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WorkflowRevisionConflictError',
        currentRevision: 2,
        currentEtag: savedTag,
      }),
    );
    await expect(
      authoring.saveDraft({
        ...input,
        representationTag: currentTag,
        workflowId: otherWorkflowId,
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });

  it("keeps a step's fields in the order they were written", async () => {
    const created = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-field-order',
      name: 'Field order',
      workspaceId,
    });
    const inputMappings = {
      zeta: { kind: 'literal', value: 1 },
      name: { kind: 'run_input', path: '$.name' },
      alpha: { kind: 'literal', value: { second: 2, first: 1 } },
    };
    await saveCurrentDraft(authoring, {
      actorId,
      expectedRevision: 1,
      graphJson: {
        ...emptyGraph,
        nodes: [
          {
            id: 'shape',
            definition: { key: 'core.set', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings,
            connectionRefs: {},
          },
        ],
      },
      workflowId: created.workflowId,
      workspaceId,
    });
    const draft = await authoring.getDraft(
      workspaceId,
      created.workflowId,
      actorId,
    );
    expect(JSON.stringify(draft?.graphJson.nodes[0]?.inputMappings)).toBe(
      JSON.stringify(inputMappings),
    );
  });
}
