import { describe, expect, it } from 'vitest';
import { requiresPublicationReviewer } from '../../src/workspaces/governance.js';

describe('governance publication reviewer requirement', () => {
  const previous = { revision: 2, requirePublishApproval: false };
  it('requires a different reviewer only when enabling approval', () => {
    expect(
      requiresPublicationReviewer(previous, {
        expectedRevision: 2,
        requirePublishApproval: true,
      }),
    ).toBe(true);
    expect(
      requiresPublicationReviewer(
        { ...previous, requirePublishApproval: true },
        { expectedRevision: 2, requirePublishApproval: true },
      ),
    ).toBe(false);
  });
  it('leaves stale commands to revision conflict handling', () => {
    expect(
      requiresPublicationReviewer(previous, {
        expectedRevision: 1,
        requirePublishApproval: true,
      }),
    ).toBe(false);
  });
  it('does not ask for reviewers when disabling or retaining the policy', () => {
    expect(
      requiresPublicationReviewer(
        { ...previous, requirePublishApproval: true },
        { expectedRevision: 2, requirePublishApproval: false },
      ),
    ).toBe(false);
    expect(requiresPublicationReviewer(previous, { expectedRevision: 2 })).toBe(
      false,
    );
  });
});
