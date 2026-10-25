import { describe, expect, it } from 'vitest';
import { publicationReviewDecision } from '../../src/authoring/reviews/decision.js';

describe('publication review decision', () => {
  const input = {
    requestedBy: 'requester',
    actorId: 'reviewer',
    state: 'pending',
    decision: 'approve',
  } as const;
  it.each(['pending', 'approved', 'rejected', 'stale', 'expired'] as const)(
    'refuses self-review before checking %s state',
    (state) => {
      expect(
        publicationReviewDecision({
          ...input,
          actorId: input.requestedBy,
          state,
        }),
      ).toMatchObject({ allowed: false, reason: 'self' });
    },
  );
  it.each(['approved', 'rejected'] as const)(
    'refuses an already %s request',
    (state) => {
      expect(publicationReviewDecision({ ...input, state })).toMatchObject({
        allowed: false,
        reason: 'decided',
      });
    },
  );
  it.each(['stale', 'expired'] as const)(
    'requires a new request for %s candidates',
    (state) => {
      expect(publicationReviewDecision({ ...input, state })).toMatchObject({
        allowed: false,
        reason: 'stale',
      });
    },
  );
  it('selects the status and audit action for each allowed decision', () => {
    expect(publicationReviewDecision(input)).toEqual({
      allowed: true,
      status: 'approved',
      action: 'workflow.publication_approved',
    });
    expect(publicationReviewDecision({ ...input, decision: 'reject' })).toEqual(
      {
        allowed: true,
        status: 'rejected',
        action: 'workflow.publication_rejected',
      },
    );
  });
});
