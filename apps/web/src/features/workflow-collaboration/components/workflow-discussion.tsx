import { useEffect, useState } from 'react';
import type { WorkflowComment } from '@pertexo/contracts';
import {
  commentDraftState,
  type CommentDraftChange,
} from '../model/comment-draft';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { WorkflowCommentThread } from '@pertexo/contracts';
import { Button } from '@/components/ui/button';
import { Status } from '@/components/ui/status';
import { Notice } from '@/components/ui/notice';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { QueryView } from '@/components/patterns/states/query-view';
import type { CollaborationScope } from '../data/collaboration.api';
import { discussionQuery } from '../data/collaboration.queries';
import { useDiscussionCommand } from '../data/collaboration.mutations';
import { DiscussionComment } from './discussion-comment';
import { CommentComposer } from './comment-composer';
import { DiscussionFeedback } from './discussion-feedback';
interface DiscussionProps {
  paused?: boolean | undefined;
  scope: CollaborationScope;
  threadId: string;
  anchor: string | undefined;
  steps: readonly { id: string; label: string }[];
  onClose: () => void;
  onLatest: () => void;
  onDraftChange: CommentDraftChange;
  onReveal: (comment: string) => void;
}
export function WorkflowDiscussion(props: DiscussionProps) {
  const { scope, threadId, anchor, onClose, onLatest } = props;
  const query = useInfiniteQuery(discussionQuery(scope, threadId, anchor));
  const [retained, setRetained] = useState<
    ReadonlyMap<string, WorkflowComment>
  >(() => new Map());
  const comments = query.data?.pages.flatMap((page) => page.comments) ?? [];
  const visible = new Map(comments.map((comment) => [comment.id, comment]));
  for (const [id, comment] of retained)
    if (!visible.has(id)) visible.set(id, comment);
  const thread = query.data?.pages[0]?.thread;
  if (thread === undefined)
    return (
      <div className="flex flex-col items-start gap-3">
        <QueryView query={query} resource="This discussion" />
        <Button variant="ghost" onClick={onClose}>
          Back to discussions
        </Button>
      </div>
    );
  return (
    <QueryView query={query} resource="This discussion">
      {() => (
        <section aria-label="Discussion" className="space-y-5">
          <DiscussionHeader {...props} thread={thread} />
          <LoadMore
            subject="comments"
            label="Older comments"
            hasNextPage={query.hasNextPage}
            loading={query.isFetchingNextPage}
            failed={query.isFetchNextPageError}
            error={query.error}
            onLoadMore={() => void query.fetchNextPage()}
          />
          <ol className="space-y-3">
            {[...visible.values()]
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
              .map((comment) => (
                <DiscussionComment
                  key={comment.id}
                  scope={scope}
                  paused={props.paused}
                  comment={comment}
                  highlighted={comment.id === anchor}
                  onDraftChange={props.onDraftChange}
                  onActiveChange={(active) => {
                    setRetained((previous) => {
                      const next = new Map(previous);
                      if (active) next.set(comment.id, comment);
                      else next.delete(comment.id);
                      return next;
                    });
                  }}
                  outsidePage={!comments.some((item) => item.id === comment.id)}
                  onReveal={() => {
                    props.onReveal(comment.id);
                  }}
                  onDeleted={onLatest}
                />
              ))}
          </ol>
          {!props.paused && thread.status === 'resolved' ? (
            <p className="text-sm text-muted-foreground">
              Reopen this discussion to reply. Your unfinished reply is kept.
            </p>
          ) : null}
          {props.paused ? null : (
            <CommentComposer
              scope={scope}
              onDraftChange={props.onDraftChange}
              target={{ kind: 'reply', threadId }}
              onSaved={onLatest}
              disabled={thread.status === 'resolved'}
            />
          )}
        </section>
      )}
    </QueryView>
  );
}
function DiscussionHeader({
  scope,
  paused,
  threadId,
  anchor,
  steps,
  onClose,
  onLatest,
  thread,
  onDraftChange,
}: DiscussionProps & { thread: WorkflowCommentThread }) {
  const command = useDiscussionCommand(
    scope,
    () => {
      onDraftChange('discussion-status', 'clean');
    },
    (status) => {
      onDraftChange('discussion-status', commentDraftState(false, status));
    },
  );
  useEffect(
    () => () => {
      onDraftChange('discussion-status', 'clean');
    },
    [onDraftChange],
  );
  const step = steps.find((item) => item.id === thread.stepId);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl">
          {thread.stepId === null
            ? 'Workflow discussion'
            : (step?.label ?? thread.stepLabel ?? 'Removed step')}
        </h2>
        <Status tone={thread.status === 'open' ? 'live' : 'success'}>
          {thread.status === 'open' ? 'Open' : 'Resolved'}
        </Status>
      </div>
      {thread.stepId !== null && step === undefined ? (
        <Notice tone="info">
          This step was removed from the draft. Its discussion remains
          available.
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {paused ? null : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={command.pending || command.uncertain}
            onClick={() =>
              void command.send({
                kind: 'status',
                threadId,
                body: {
                  status: thread.status === 'open' ? 'resolved' : 'open',
                  expectedRevision: thread.revision,
                },
              })
            }
          >
            {thread.status === 'open'
              ? 'Resolve discussion'
              : 'Reopen discussion'}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Back to discussions
        </Button>
        {anchor === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={onLatest}>
            Latest replies
          </Button>
        )}
      </div>
      <DiscussionFeedback command={command} />
    </>
  );
}
