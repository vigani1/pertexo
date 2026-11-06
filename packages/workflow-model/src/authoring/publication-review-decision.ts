/** Publication requires a different reviewer and one still-pending candidate. */
export function publicationReviewDecision(
  input: Readonly<{
    requestedBy: string;
    actorId: string;
    state: 'pending' | 'approved' | 'rejected' | 'stale' | 'expired';
    decision: 'approve' | 'reject';
  }>,
):
  | Readonly<{
      allowed: false;
      reason: 'self' | 'decided' | 'stale';
      message: string;
    }>
  | Readonly<{
      allowed: true;
      status: 'approved' | 'rejected';
      action: 'workflow.publication_approved' | 'workflow.publication_rejected';
    }> {
  if (input.requestedBy === input.actorId)
    return {
      allowed: false,
      reason: 'self',
      message: 'Another owner or admin must decide your publication request.',
    };
  if (input.state !== 'pending')
    return {
      allowed: false,
      reason:
        input.state === 'approved' || input.state === 'rejected'
          ? 'decided'
          : 'stale',
      message:
        'This publication request is no longer pending. Review the latest draft and request approval again.',
    };
  return input.decision === 'approve'
    ? {
        allowed: true,
        status: 'approved',
        action: 'workflow.publication_approved',
      }
    : {
        allowed: true,
        status: 'rejected',
        action: 'workflow.publication_rejected',
      };
}
