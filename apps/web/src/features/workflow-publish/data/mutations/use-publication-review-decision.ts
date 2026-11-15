import { useQueryClient } from '@tanstack/react-query';
import type {
  PublicationReview,
  PublicationReviewDecision,
} from '@pertexo/contracts';
import { inboxKeys } from '@/features/inbox/inbox-queries.public';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import { isApiError } from '@/lib/api/error';
import { commandErrorMessage } from '@/lib/workflows/command-errors';
import {
  decidePublicationReview,
  type ReviewScope,
} from '../reviews/publication-review.api';
import { publicationReviewKeys } from '../reviews/publication-review.queries';
import { invalidatePublishedWorkflow } from '../workflow-publish.queries';

/**
 * Approves or rejects a publication request. A conflict or an invalid
 * workflow refreshes the review first, so the reviewer sees what changed;
 * a decision refreshes the review, the workflow and the inbox.
 */
export function usePublicationReviewDecision(
  scope: ReviewScope,
  request: PublicationReview,
) {
  const cache = useQueryClient();
  return useRetainedCommand(
    async (body: PublicationReviewDecision, key: string) => {
      try {
        return await decidePublicationReview(scope, request.id, body, key);
      } catch (cause) {
        if (
          isApiError(cause) &&
          (cause.problem?.code === 'workflow.publication_review_conflict' ||
            cause.problem?.code === 'workflow.invalid')
        )
          await cache.invalidateQueries({
            queryKey: publicationReviewKeys.scope(scope),
          });
        throw cause;
      }
    },
    async () => {
      await cache.invalidateQueries({
        queryKey: publicationReviewKeys.scope(scope),
      });
      await invalidatePublishedWorkflow(cache, scope, request.workflowId);
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    {
      action: 'deciding publication',
      failureMessage: (cause) =>
        isApiError(cause) &&
        cause.problem?.code === 'workflow.publication_review_conflict'
          ? cause.problem.detail
          : commandErrorMessage(cause, 'deciding publication'),
    },
  );
}
