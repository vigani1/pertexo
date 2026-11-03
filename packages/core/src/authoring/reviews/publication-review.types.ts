import type { PublicationReviewDecision } from '@pertexo/contracts';
import type { AuthoringCatalogs } from '../workflows/catalogs.js';

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

export type ReviewOverviewInput = ReviewScope & { workflowId: string };
export type ReadReviewInput = ReviewScope & { reviewId: string };
export type RequestReviewInput = ReviewCommand & {
  workflowId: string;
  representationTag: string;
  note: string;
};
export type DecideReviewInput = ReviewCommand &
  PublicationReviewDecision & { reviewId: string };

export type ReviewDependencies = Readonly<{ catalogs: AuthoringCatalogs }>;
