import { inboxKeys } from '@/features/inbox/queries.public';
import { workflowKeys } from '@/features/workflows/queries.public';
import { workflowPublishKeys } from '../../data/workflow-publish.queries';
import { useId } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  PublicationReview,
  PublicationReviewDecision,
} from '@pertexo/contracts';
import { LabelledField, FieldGroup } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/components/ui/progress-button';
import { Notice } from '@/components/ui/notice';
import { useFieldValues } from '@/components/ui/use-field-validation';
import { useRetainedCommand } from '@/lib/api/commands/use-retained';
import {
  decidePublicationReview,
  type ReviewScope,
} from '../../data/reviews/api';
import { publicationReviewKeys } from '../../data/reviews/queries';
export function ReviewDecision({
  scope,
  request,
}: Readonly<{ scope: ReviewScope; request: PublicationReview }>) {
  const id = useId(),
    cache = useQueryClient();
  const fields = useFieldValues(
    {
      comment: (value: string) =>
        value.trim().length <= 1000
          ? undefined
          : 'Keep the comment under 1,000 characters.',
    },
    { comment: '' },
  );
  const command = useRetainedCommand(
    (body: PublicationReviewDecision, key: string) =>
      decidePublicationReview(scope, request.id, body, key),
    async () => {
      await cache.invalidateQueries({
        queryKey: publicationReviewKeys.scope(scope),
      });
      await cache.invalidateQueries({
        queryKey: workflowKeys.scope(scope.userId, scope.workspaceId),
      });
      await cache.invalidateQueries({
        queryKey: workflowPublishKeys.latestVersion(
          scope.userId,
          scope.workspaceId,
          request.workflowId,
        ),
      });
      await cache.invalidateQueries({
        queryKey: inboxKeys.scope(scope.userId, scope.workspaceId),
      });
    },
    { action: 'deciding publication' },
  );
  const locked = !request.canDecide || command.pending || command.uncertain;
  const decide = (decision: PublicationReviewDecision['decision']) => {
    const parsed = fields.validate();
    if (parsed !== undefined && !locked)
      void command.send({ decision, comment: parsed.comment.trim() });
  };
  return (
    <FieldGroup>
      <ReviewStateNotice request={request} userId={scope.userId} />
      {request.status === 'pending' && request.canDecide ? (
        <>
          <LabelledField
            id={id}
            label="Review comment (optional)"
            error={fields.error('comment')}
            description="Visible to workspace members on this request. Kept out of audit metadata and notification emails."
          >
            {(control) => (
              <Textarea
                {...control}
                {...fields.control('comment')}
                rows={3}
                maxLength={1000}
                disabled={locked}
              />
            )}
          </LabelledField>
          <div className="flex flex-wrap gap-3">
            <ProgressButton
              type="button"
              variant="primary"
              pending={command.pending}
              pendingLabel="Recording decision…"
              disabled={locked}
              onClick={() => {
                decide('approve');
              }}
            >
              Approve and publish
            </ProgressButton>
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                decide('reject');
              }}
            >
              Reject
            </Button>
          </div>
        </>
      ) : null}
      {command.error === undefined ? null : (
        <Notice
          tone="warning"
          action={
            command.uncertain ? (
              <Button
                type="button"
                variant="outline"
                disabled={command.pending || command.expired}
                onClick={command.retry}
              >
                Retry same decision
              </Button>
            ) : undefined
          }
        >
          {command.error}
        </Notice>
      )}
    </FieldGroup>
  );
}

function ReviewStateNotice({
  request,
  userId,
}: Readonly<{ request: PublicationReview; userId: string }>) {
  if (request.status === 'pending') {
    if (request.canDecide) return null;
    return (
      <Notice>
        {request.requestedBy === userId
          ? 'Another owner or admin must decide your publication request.'
          : 'Only a current workspace owner or admin can decide this request.'}
      </Notice>
    );
  }
  if (request.status === 'approved')
    return (
      <Notice>
        Published v{request.versionNumber}. This decision is complete.
      </Notice>
    );
  if (request.status === 'rejected')
    return <Notice>This publication request was rejected.</Notice>;
  return (
    <Notice>
      This request is stale or expired. Review the latest draft and request
      approval again.
    </Notice>
  );
}
