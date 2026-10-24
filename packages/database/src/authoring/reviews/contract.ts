import type {
  PublicationReview,
  PublicationReviewOverview,
  PublicationReviewDetail,
  PublicationReviewDecision,
} from '@pertexo/contracts';
import type { WorkflowPublicationDependencies } from '../publication/contract.js';

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
