import type { Role } from '@pertexo/workflow-model';
import { toProblem } from '../../../src/problems/registry.js';
import { authoringFailure } from '../../../src/problems/context/normalize.js';
import { expect, it, vi } from 'vitest';
import type { PublicationReviewStore } from '@pertexo/database/authoring';
import { PublicationReviewError } from '@pertexo/database/authoring';
import { createActorContext } from '../../../src/authorization/index.js';
import { PublicationReviewUseCase } from '../../../src/workflow-authoring/reviews/use-case.js';

const actorId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  reviewId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const actor = createActorContext({
  actorId,
  workspaceId,
  sessionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  requestId: 'review-test',
});
const review = {
  id: reviewId,
  workflowId,
  workflowName: 'Release',
  requestedBy: actorId,
  requesterName: 'Builder',
  draftRevision: 4,
  note: 'Review this change.',
  status: 'pending' as const,
  createdAt: '2026-10-18T10:00:00.000Z',
  expiresAt: '2026-10-25T10:00:00.000Z',
  decidedBy: null,
  deciderName: null,
  decidedAt: null,
  comment: null,
  publishedVersionId: null,
  versionNumber: null,
  canDecide: false,
};
function fixture(role: Role) {
  const store = {
    overview: vi.fn().mockResolvedValue({ required: true, request: review }),
    read: vi
      .fn()
      .mockResolvedValue({ request: review, graph: null, liveGraph: null }),
    request: vi.fn().mockResolvedValue(review),
    decide: vi.fn().mockResolvedValue(review),
  } satisfies PublicationReviewStore;
  const authorization = {
    findAccess: vi.fn().mockResolvedValue({
      actorId,
      workspaceId,
      role,
      membershipStatus: 'active',
      workspaceStatus: 'active',
    }),
  };
  return {
    store,
    controls: new PublicationReviewUseCase(store, authorization),
  };
}
it('lets a builder request the exact representation and trims its bounded note at the boundary', async () => {
  const f = fixture('builder'),
    signal = new AbortController().signal;
  const representationTag = `"draft.${'a'.repeat(43)}"`;
  await f.controls.request({
    actor,
    routeWorkspaceId: workspaceId,
    workflowId,
    representationTag,
    request: { note: '  Review this change.  ' },
    idempotencyKey: 'one-request',
    signal,
  });
  expect(f.store.request).toHaveBeenCalledWith({
    workspaceId,
    actorId,
    workflowId,
    representationTag,
    note: 'Review this change.',
    idempotencyKey: 'one-request',
    requestId: 'review-test',
    signal,
  });
  await expect(
    f.controls.request({
      actor,
      routeWorkspaceId: workspaceId,
      workflowId,
      representationTag,
      request: { note: '', graph: {} },
      idempotencyKey: 'invalid',
    }),
  ).rejects.toMatchObject({ name: 'ZodError' });
  expect(f.store.request).toHaveBeenCalledTimes(1);
});
it.each(['builder', 'operator', 'viewer'] as const)(
  'refuses decisions by %s before touching persistence',
  async (role) => {
    const f = fixture(role);
    await expect(
      f.controls.decide({
        actor,
        routeWorkspaceId: workspaceId,
        reviewId,
        request: { decision: 'approve' },
        idempotencyKey: 'denied',
      }),
    ).rejects.toMatchObject({ code: 'resource.not_found' });
    expect(f.store.decide).not.toHaveBeenCalled();
  },
);
it.each(['owner', 'admin'] as const)(
  'allows a current %s to send a scoped, idempotent decision',
  async (role) => {
    const f = fixture(role);
    await f.controls.decide({
      actor,
      routeWorkspaceId: workspaceId,
      reviewId,
      request: { decision: 'reject', comment: 'Check the mapping.' },
      idempotencyKey: 'one-decision',
    });
    expect(f.store.decide).toHaveBeenCalledWith({
      workspaceId,
      actorId,
      reviewId,
      decision: 'reject',
      comment: 'Check the mapping.',
      idempotencyKey: 'one-decision',
      requestId: 'review-test',
    });
  },
);
it('returns explicit policy and review conflicts through the shared authoring error owner', () => {
  expect(
    toProblem(
      authoringFailure(
        new PublicationReviewError('required', 'Request review.'),
      ),
    ).code,
  ).toBe('workflow.publish_approval_required');
  expect(
    toProblem(
      authoringFailure(new PublicationReviewError('stale', 'Draft changed.')),
    ).code,
  ).toBe('workflow.publication_review_conflict');
});
