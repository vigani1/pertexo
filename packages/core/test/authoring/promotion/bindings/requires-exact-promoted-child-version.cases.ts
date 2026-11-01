import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { WorkflowGraph } from '@pertexo/workflow-model';

import {
  actorId,
  workspaceId,
  emptyGraph,
  currentRepresentationTag,
  saveCurrentDraft,
} from '../../../support/workflow-authoring.js';
import { db, scope, promotions, node, published, promote } from './fixture.js';

export function registerRequiresExactPromotedChildVersion(): void {
  it('requires the exact promoted child version and retains independent historical correspondences', async () => {
    const callable: WorkflowGraph = {
      ...emptyGraph,
      nodes: [node('manual', 'core.manual'), node('stop', 'core.terminate')],
      callable: {
        input: { type: 'string' },
        resultType: { type: 'string' },
        result: { kind: 'run_input', path: '$' },
      },
    };
    const child = await published(callable);
    const parent = await published({
      ...callable,
      nodes: [
        ...callable.nodes,
        node('call', 'core.call', {
          target: {
            workflowId: child.workflowId,
            workflowVersionId: child.versionId,
            executableChecksum: child.checksum,
          },
        }),
      ],
    });
    expect(
      (
        await promotions().preview({
          ...scope(),
          selections: [parent],
          mode: 'draft',
        })
      ).requirements,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'call', status: 'missing' }),
      ]),
    );
    const targetChild = await promote(child, 'publish');
    const targetParent = await promote(parent, 'publish');
    const pin = targetParent.review.workflows[0]?.proposedGraph.nodes.find(
      (step) => step.id === 'call',
    )?.config.target;
    expect(pin).toMatchObject({
      workflowId: targetChild.item.targetWorkflowId,
      workflowVersionId: targetChild.item.publishedVersionId,
    });
    const draft = await db.getDraft(workspaceId, child.workflowId, actorId);
    if (draft === null) throw new Error('Missing child draft');
    await saveCurrentDraft(db, {
      ...scope(),
      workflowId: child.workflowId,
      expectedRevision: draft.revision,
      graphJson: { ...callable, settings: { maxRunDurationMs: 5000 } },
    });
    const next = (
      await db.publishWorkflow({
        ...scope(),
        workflowId: child.workflowId,
        representationTag: await currentRepresentationTag(db, workspaceId, {
          scopedWorkflowId: child.workflowId,
          scopedActorId: actorId,
        }),
        requestHash: 'b'.repeat(64),
        idempotencyKey: randomUUID(),
      })
    ).version;
    await promote(
      { workflowId: child.workflowId, versionId: next.id },
      'publish',
    );
    const again = await promotions().preview({
      ...scope(),
      selections: [parent],
      mode: 'draft',
    });
    expect(
      again.workflows[0]?.proposedGraph.nodes.find((step) => step.id === 'call')
        ?.config.target,
    ).toEqual(pin);
  });
}
