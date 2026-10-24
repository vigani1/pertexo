import type {
  PublicationReview,
  PublicationReviewOverview,
  PublicationReviewDetail,
  PublicationReviewDecision,
} from '@pertexo/contracts';
import type { WorkflowPublicationDependencies } from '../publication/publisher.repository.js';

export type ReviewScope = Readonly<{
  workspaceId: string;
  actorId: string;
  signal?: AbortSignal;
}>;
export type ReviewCommand = ReviewScope &
  Readonly<{
    idempotencyKey: string;
    requestId?: string;
    traceId?: string;
    traceparent?: string;
  }>;
export interface PublicationReviewStore {
  overview(
    input: ReviewScope & { workflowId: string },
  ): Promise<PublicationReviewOverview>;
  read(
    input: ReviewScope & { reviewId: string },
  ): Promise<PublicationReviewDetail>;
  request(
    input: ReviewCommand & {
      workflowId: string;
      representationTag: string;
      note: string;
    },
  ): Promise<PublicationReview>;
  decide(
    input: ReviewCommand & PublicationReviewDecision & { reviewId: string },
  ): Promise<PublicationReview>;
}
export type ReviewDependencies = WorkflowPublicationDependencies;
export class PublicationReviewError extends Error {
  override readonly name = 'PublicationReviewError';
  constructor(
    readonly reason:
      'required' | 'disabled' | 'stale' | 'self' | 'decided' | 'limit',
    message: string,
  ) {
    super(message);
  }
}
