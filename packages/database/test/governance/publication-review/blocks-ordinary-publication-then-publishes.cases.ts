import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import {
  actorId,
  workspaceId,
  authoring,
  emptyGraph,
  currentRepresentationTag,
  saveCurrentDraft,
  queryAsOwner,
} from '../../support/workflow-authoring.js';

import { builder, admin, settings, reviews, request } from './fixture.js';

export function registerBlocksOrdinaryPublicationThenPublishes(): void {
  it('blocks ordinary publication, then publishes the reviewed revision once with a different reviewer', async () => {
    const { command, review } = await request();
    await expect(
      authoring.publishWorkflow({
        ...command,
        requestHash: 'a'.repeat(64),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'required' });
    expect(
      (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
        .graph,
    ).toEqual(emptyGraph);
    await expect(
      reviews().decide({
        workspaceId,
        actorId: builder,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('visible');
    const decision = {
      workspaceId,
      actorId,
      reviewId: review.id,
      decision: 'approve' as const,
      requestId: 'review-decision',
      traceId: 'a'.repeat(32),
      idempotencyKey: randomUUID(),
    };
    const approved = await reviews().decide(decision);
    expect(approved).toMatchObject({
      status: 'approved',
      versionNumber: 1,
      decidedBy: actorId,
      canDecide: false,
    });
    expect(await reviews().decide(decision)).toEqual(approved);
    const facts = await queryAsOwner<{
      action: string;
      metadata: unknown;
      request_id: string | null;
      trace_id: string | null;
    }>(
      'select action,metadata,request_id,trace_id from app.audit_events where workspace_id=$1 and target_id=$2',
      [workspaceId, review.workflowId],
      workspaceId,
    );
    expect(
      facts.filter((fact) => fact.action === 'workflow.published'),
    ).toHaveLength(1);
    expect(
      facts.filter((fact) => fact.action === 'workflow.publication_approved'),
    ).toHaveLength(1);
    expect(
      facts.find((fact) => fact.action === 'workflow.publication_approved'),
    ).toMatchObject({
      request_id: 'review-decision',
      trace_id: 'a'.repeat(32),
    });
    expect(JSON.stringify(facts)).not.toContain('PRIVATE_REVIEW_NOTE');
  });

  it('requires another reviewer for an owner request and allows rejection without publishing', async () => {
    const { review } = await request(actorId);
    await expect(
      reviews().decide({
        workspaceId,
        actorId,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'self' });
    const rejected = await reviews().decide({
      workspaceId,
      actorId: admin,
      reviewId: review.id,
      decision: 'reject',
      comment: 'Please clarify the conditions.',
      idempotencyKey: randomUUID(),
    });
    expect(rejected).toMatchObject({
      status: 'rejected',
      publishedVersionId: null,
      comment: 'Please clarify the conditions.',
    });
  });

  it('invalidates an edited draft without presenting its replacement as the reviewed graph', async () => {
    const { command, review } = await request();
    await saveCurrentDraft(authoring, {
      workspaceId,
      actorId: builder,
      workflowId: review.workflowId,
      expectedRevision: 1,
      graphJson: { ...emptyGraph, settings: { maxRunDurationMs: 60000 } },
    });
    expect(
      await reviews().read({ workspaceId, actorId, reviewId: review.id }),
    ).toMatchObject({
      graph: null,
      request: { status: 'stale', canDecide: false },
    });
    await expect(
      reviews().decide({
        workspaceId,
        actorId,
        reviewId: review.id,
        decision: 'approve',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: 'stale' });
    expect(
      (
        await reviews().request({
          ...command,
          representationTag: await currentRepresentationTag(
            authoring,
            workspaceId,
            { scopedWorkflowId: review.workflowId, scopedActorId: builder },
          ),
          idempotencyKey: randomUUID(),
        })
      ).draftRevision,
    ).toBe(2);
  });

  it('chooses one winner when reviewers race', async () => {
    const { review } = await request();
    const attempts = await Promise.allSettled(
      [actorId, admin].map((reviewer) =>
        reviews().decide({
          workspaceId,
          actorId: reviewer,
          reviewId: review.id,
          decision: 'approve',
          idempotencyKey: randomUUID(),
        }),
      ),
    );
    expect(
      attempts.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      attempts.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('makes policy changes invalidate earlier requests permanently', async () => {
    const { review } = await request();
    for (const enabled of [false, true]) {
      const snapshot = await settings.settings({ workspaceId, actorId });
      await settings.configure({
        workspaceId,
        actorId,
        expectedRevision: snapshot.revision,
        requirePublishApproval: enabled,
        idempotencyKey: randomUUID(),
      });
    }
    expect(
      (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
        .request.status,
    ).toBe('stale');
  });

  it('rechecks requester membership and seven-day expiry at decision time', async () => {
    const { review } = await request();
    await queryAsOwner(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, builder],
      workspaceId,
    );
    try {
      await expect(
        reviews().decide({
          workspaceId,
          actorId,
          reviewId: review.id,
          decision: 'approve',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ reason: 'stale' });
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set role='builder' where workspace_id=$1 and user_id=$2",
        [workspaceId, builder],
        workspaceId,
      );
    }
    await queryAsOwner(
      "update app.workflow_publication_requests set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where workspace_id=$1 and id=$2",
      [workspaceId, review.id],
      workspaceId,
    );
    expect(
      (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
        .request.status,
    ).toBe('expired');
  });
}
