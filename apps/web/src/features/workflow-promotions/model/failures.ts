import { isApiError } from '@/lib/api/error';

/** These details are deliberately projected as safe promotion recovery copy. */
export function promotionFailureMessage(cause: unknown): string | undefined {
  return isApiError(cause) &&
    (cause.problem?.code === 'workflow.promotion_conflict' ||
      cause.problem?.code === 'workflow.promotion_unavailable')
    ? cause.problem.detail
    : undefined;
}

export function requiresPromotionReview(cause: unknown): boolean {
  return (
    isApiError(cause) && cause.problem?.code === 'workflow.promotion_conflict'
  );
}
