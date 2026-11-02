import type { WorkflowGraph } from '@pertexo/workflow-model';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  otherActorId,
  workspaceId,
  otherWorkspaceId,
  emptyGraph,
  currentRepresentationTag,
  queryAsOwner,
  purgeTestWorkspace,
  saveCurrentDraft,
} from '../../../support/workflow-authoring.js';
import {
  database,
  scope,
  promotions,
  configure,
  published,
} from './fixture.js';

export function registerQualifies20WorkflowBatchWithin(): void {
  it('qualifies a 20-workflow batch within byte bounds and refuses a review that exceeds them', async () => {
    await configure();
    const selections = [];
    const largeGraph = (bytes: number): WorkflowGraph => ({
      ...emptyGraph,
      nodes: [
        {
          id: 'payload',
          definition: { key: 'test.placeholder', version: 1 },
          configVersion: 1,
          config: { value: 'x'.repeat(bytes) },
          inputMappings: {},
          connectionRefs: {},
          position: { x: 0, y: 0 },
        },
      ],
    });
    for (let index = 0; index < 20; index++)
      selections.push(await published(largeGraph(50_000)));
    const started = performance.now(),
      memoryBefore = process.memoryUsage();
    const review = await promotions().preview({
      ...scope(),
      selections,
      mode: 'draft',
    });
    const previewMs = performance.now() - started;
    expect(review.compatible).toBe(true);
    const applying = performance.now();
    await promotions().apply({
      ...scope(),
      selections,
      mode: 'draft',
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const applyMs = performance.now() - applying;
    const maximumReview = await promotions().preview({
      ...scope(),
      selections,
      mode: 'draft',
    });
    const memoryAfter = process.memoryUsage();
    const responseBytes = Buffer.byteLength(JSON.stringify(maximumReview));
    expect(responseBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(maximumReview.workflows).toHaveLength(20);
    process.stdout.write(
      `PROMOTION_BOUND=${JSON.stringify({
        workflows: 20,
        responseBytes,
        previewMs,
        applyMs,
        rssBefore: memoryBefore.rss,
        rssAfter: memoryAfter.rss,
        maxRssKiB: process.resourceUsage().maxRSS,
        rssDelta: memoryAfter.rss - memoryBefore.rss,
        heapDelta: memoryAfter.heapUsed - memoryBefore.heapUsed,
      })}\n`,
    );
    const huge = await published(largeGraph(980_000));
    await expect(
      promotions().preview({
        ...scope(),
        selections: [huge, ...selections.slice(0, 19)],
        mode: 'draft',
      }),
    ).rejects.toMatchObject({ reason: 'limit' });
  }, 60000);

  it('records correspondence after F18 approves exactly the promoted draft, but never for a later manual edit', async () => {
    await configure();
    const selection = await published();
    await queryAsOwner(
      'update app.workspaces set require_publish_approval=true where id=$1',
      [otherWorkspaceId],
      otherWorkspaceId,
    );
    const reviews = database.publicationReviews;
    let targetWorkflowId = '';
    try {
      const review = await promotions().preview({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
      });
      const applied = await promotions().apply({
        ...scope(),
        selections: [selection],
        mode: 'request_approval',
        fingerprint: review.fingerprint,
        acknowledgeTargetChanges: [],
        note: 'Review the exact promoted version.',
        idempotencyKey: randomUUID(),
      });
      const item = applied.items[0];
      if (item?.publicationRequestId === null || item === undefined)
        throw new Error('Publication review missing');
      targetWorkflowId = item.targetWorkflowId;
      const approved = await reviews.decide({
        workspaceId: otherWorkspaceId,
        actorId: otherActorId,
        reviewId: item.publicationRequestId,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      });
      expect(approved.status).toBe('approved');
      expect(
        await queryAsOwner(
          'select version_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
          [otherWorkspaceId, targetWorkflowId],
          otherWorkspaceId,
        ),
      ).toEqual([{ version_id: approved.publishedVersionId }]);
    } finally {
      await queryAsOwner(
        'update app.workspaces set require_publish_approval=false where id=$1',
        [otherWorkspaceId],
        otherWorkspaceId,
      );
    }
    await saveCurrentDraft(database, {
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: targetWorkflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 15000 } },
    });
    const manual = await database.publishWorkflow({
      workspaceId: otherWorkspaceId,
      actorId,
      workflowId: targetWorkflowId,
      representationTag: await currentRepresentationTag(
        database,
        otherWorkspaceId,
        { scopedWorkflowId: targetWorkflowId, scopedActorId: actorId },
      ),
      requestHash: 'a'.repeat(64),
      idempotencyKey: randomUUID(),
    });
    expect(
      await queryAsOwner(
        'select version_id from app.workflow_version_promotions where workspace_id=$1 and version_id=$2',
        [otherWorkspaceId, manual.version.id],
        otherWorkspaceId,
      ),
    ).toEqual([]);
  });

  it('purges each environment independently and removes its owned promotion metadata', async () => {
    await configure();
    const selection = await published();
    const review = await promotions().preview({
      ...scope(),
      selections: [selection],
      mode: 'publish',
    });
    const applied = await promotions().apply({
      ...scope(),
      selections: [selection],
      mode: 'publish',
      fingerprint: review.fingerprint,
      acknowledgeTargetChanges: [],
      idempotencyKey: randomUUID(),
    });
    const item = applied.items[0];
    if (item === undefined) throw new Error('Promoted target missing');
    await purgeTestWorkspace(workspaceId);
    expect(
      await database.getDraft(otherWorkspaceId, item.targetWorkflowId, actorId),
    ).not.toBeNull();
    expect(
      await queryAsOwner(
        'select source_workspace_id,source_workflow_id from app.workflow_version_promotions where workspace_id=$1 and workflow_id=$2',
        [otherWorkspaceId, item.targetWorkflowId],
        otherWorkspaceId,
      ),
    ).toEqual([
      {
        source_workspace_id: workspaceId,
        source_workflow_id: selection.workflowId,
      },
    ]);
    await purgeTestWorkspace(otherWorkspaceId);
    expect(
      await queryAsOwner(
        'select (select count(*)::int from app.workspace_promotion_targets where workspace_id=any($1::uuid[])) links,(select count(*)::int from app.workflow_promotion_origins where workspace_id=$2) origins,(select count(*)::int from app.workflow_version_promotions where workspace_id=$2) versions',
        [[workspaceId, otherWorkspaceId], otherWorkspaceId],
        otherWorkspaceId,
      ),
    ).toEqual([{ links: 0, origins: 0, versions: 0 }]);
  }, 60000);
}
