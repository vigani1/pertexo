import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';

import { parseDatabaseConfig } from '@pertexo/database/platform';
import {
  observer,
  inbox,
  preferences,
  mail,
} from '../../inbox/notices.fixture.js';
import {
  apiUrl,
  actorId,
  workspaceId,
  queryAsOwner,
  otherWorkspaceId,
  enforceTestRetention,
} from '../../support/workflow-authoring.js';
import { createWorkflowAuthoringFixtureDatabase } from '../../support/workflow-authoring-admission.fixture.js';
import { builder, admin, reviews, request } from './fixture.js';

export function registerUsesSharedInboxAudiencePersonal(): void {
  it('uses the shared inbox audience and personal delivery without exposing the request note', async () => {
    const { review } = await request();
    await queryAsOwner(
      'update app.users set email_verified=true where id=any($1::uuid[])',
      [[actorId, builder, admin]],
    );
    const prefs = preferences();
    await prefs.replace({
      workspaceId,
      actorId: admin,
      expectedRevision: 0,
      mode: 'immediate',
      hour: 9,
      timeZone: 'UTC',
      idempotencyKey: randomUUID(),
    });
    const observe = observer();
    if (observe.observeCurrent === undefined)
      throw new Error('Attention observer missing');
    await observe.observeCurrent();
    const reader = inbox();
    const list = (memberId: string) =>
      reader.listThreads({
        workspaceId,
        actorId: memberId,
        filter: 'all',
        noticeKind: 'publication_review_waiting',
        limit: 100,
      });
    expect(
      (await list(admin)).items.some(
        (item) =>
          item.noticeKind === 'publication_review_waiting' &&
          item.subjectId === review.id,
      ),
    ).toBe(true);
    expect((await list(builder)).items).toHaveLength(0);
    const captured: Parameters<typeof mail>[0] = [];
    await mail(captured).prepare();
    expect(
      captured.some((batch) =>
        batch.items.some((item) => item.subjectId === review.id),
      ),
    ).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_REVIEW_NOTE');
    await reviews().decide({
      workspaceId,
      actorId,
      reviewId: review.id,
      decision: 'reject',
      idempotencyKey: randomUUID(),
    });
    // The decision hides a notice immediately, before another observer pass.
    expect(
      (await list(admin)).items.some(
        (item) =>
          item.noticeKind === 'publication_review_waiting' &&
          item.subjectId === review.id,
      ),
    ).toBe(false);
  });

  it('rejects catalog drift and rolls a failed publication back without deciding its request', async () => {
    const { review } = await request();
    const drifted = createWorkflowAuthoringFixtureDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        definitionCatalog: {
          definitions: [{ key: 'test.drifted', version: 1 }],
        },
      },
    );
    const broken = createWorkflowAuthoringFixtureDatabase(
      parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
      {
        executableCompiler: () => {
          throw new Error('Compiler unavailable');
        },
      },
    );
    try {
      expect(
        await drifted.publicationReviews.read({
          workspaceId,
          actorId,
          reviewId: review.id,
        }),
      ).toMatchObject({
        graph: null,
        request: { status: 'stale', canDecide: false },
      });
      await expect(
        drifted.publicationReviews.decide({
          workspaceId,
          actorId,
          reviewId: review.id,
          decision: 'approve',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({ name: 'WorkflowRevisionConflictError' });
      await expect(
        broken.publicationReviews.decide({
          workspaceId,
          actorId,
          reviewId: review.id,
          decision: 'approve',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('Compiler unavailable');
      expect(
        (await reviews().read({ workspaceId, actorId, reviewId: review.id }))
          .request.status,
      ).toBe('pending');
      const facts = await queryAsOwner<{ count: number }>(
        "select count(*)::int count from app.audit_events where workspace_id=$1 and target_id=$2 and action in ('workflow.published','workflow.publication_approved')",
        [workspaceId, review.workflowId],
        workspaceId,
      );
      expect(facts[0]?.count).toBe(0);
    } finally {
      await Promise.all([drifted.close(), broken.close()]);
    }
  });

  it('fences reviewer demotion and cross-workspace reads', async () => {
    const { review } = await request();
    await expect(
      reviews().read({
        workspaceId: otherWorkspaceId,
        actorId,
        reviewId: review.id,
      }),
    ).rejects.toThrow('visible');
    await queryAsOwner(
      "update app.workspace_memberships set role='viewer' where workspace_id=$1 and user_id=$2",
      [workspaceId, admin],
      workspaceId,
    );
    try {
      await expect(
        reviews().decide({
          workspaceId,
          actorId: admin,
          reviewId: review.id,
          decision: 'approve',
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow('visible');
    } finally {
      await queryAsOwner(
        "update app.workspace_memberships set role='admin' where workspace_id=$1 and user_id=$2",
        [workspaceId, admin],
        workspaceId,
      );
    }
  });

  it('expires request content through the existing maintenance retention owner', async () => {
    const { review } = await request();
    await queryAsOwner(
      "update app.workflow_publication_requests set created_at=clock_timestamp()-interval '39 days',expires_at=clock_timestamp()-interval '32 days' where workspace_id=$1 and id=$2",
      [workspaceId, review.id],
      workspaceId,
    );
    await enforceTestRetention();
    await expect(
      reviews().read({ workspaceId, actorId, reviewId: review.id }),
    ).rejects.toThrow('visible');
  });
}
