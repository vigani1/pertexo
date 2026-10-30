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
import { DiscussionComment } from './comment';
import { CommentComposer } from './composer';
import { DiscussionFeedback } from './command-feedback';
interface DiscussionProps {
  paused?: boolean | undefined;
  scope: CollaborationScope;
  threadId: string;
  anchor: string | undefined;
  steps: readonly { id: string; label: string }[];
  onClose: () => void;
  onLatest: () => void;
}
export function WorkflowDiscussion(props: DiscussionProps) {
  const { scope, threadId, anchor, onClose, onLatest } = props;
  const query = useInfiniteQuery(discussionQuery(scope, threadId, anchor));
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
    <section aria-label="Discussion" className="space-y-5">
      <DiscussionHeader {...props} thread={thread} />
      <LoadMore
        subject="comments"
        label="Older comments"
        hasNextPage={query.hasNextPage}
        loading={query.isFetchingNextPage}
        failed={query.isFetchNextPageError}
        onLoadMore={() => void query.fetchNextPage()}
      />
      <QueryView query={query} resource="This discussion" />
      <ol className="space-y-3">
        {query.data?.pages
          .flatMap((page) => page.comments)
          .slice()
          .reverse()
          .map((comment) => (
            <DiscussionComment
              key={comment.id}
              scope={scope}
              paused={props.paused}
              comment={comment}
              highlighted={comment.id === anchor}
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
          target={{ kind: 'reply', threadId }}
          onSaved={onLatest}
          disabled={thread.status === 'resolved'}
        />
      )}
    </section>
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
}: DiscussionProps & { thread: WorkflowCommentThread }) {
  const command = useDiscussionCommand(scope);
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
