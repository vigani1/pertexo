import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from '@tanstack/react-router';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type {
  CommentDraftChange,
  CommentDraftState,
} from '../model/comment-draft';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { CollaborationScope } from '../data/collaboration.api';
import { CommentComposer } from '../components/comment-composer';
import { WorkflowDiscussion } from '../components/workflow-discussion';
import { DiscussionThreads } from '../components/discussion-thread-list';
interface Search {
  thread?: string | undefined;
  comment?: string | undefined;
  step?: string | undefined;
}
interface PageProps {
  scope: CollaborationScope;
  /** A suspended workspace shows its discussions but takes no new words. */
  paused?: boolean | undefined;
  steps: readonly { id: string; label: string }[];
  search: Search;
  onNavigate: (search: Search) => void;
}
export function WorkflowCommentsPage(props: PageProps) {
  return (
    <WorkflowCommentsSession
      key={`${props.scope.userId}:${props.scope.workspaceId}:${props.scope.workflowId}`}
      {...props}
    />
  );
}
function WorkflowCommentsSession(props: PageProps) {
  const { scope, steps, search, onNavigate } = props;
  const guard = useCommentDraftGuard();
  return (
    <>
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h2 className="font-display text-3xl">Comments</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Talk about the workflow or one step. Mention someone to bring them
            in.
          </p>
        </div>
        {search.thread === undefined ? (
          <ThreadOverview {...props} onDraftChange={guard.onDraftChange} />
        ) : (
          <WorkflowDiscussion
            key={search.thread}
            scope={scope}
            onDraftChange={guard.onDraftChange}
            onReveal={(comment) => {
              onNavigate({ thread: search.thread, comment });
            }}
            paused={props.paused}
            threadId={search.thread}
            anchor={search.comment}
            steps={steps}
            onClose={() => {
              onNavigate(
                search.step === undefined ? {} : { step: search.step },
              );
            }}
            onLatest={() => {
              onNavigate({ thread: search.thread });
            }}
          />
        )}
      </div>
      <CommentLeaveDialog guard={guard} />
    </>
  );
}
function ThreadOverview({
  scope,
  onDraftChange,
  paused = false,
  steps,
  search,
  onNavigate,
}: PageProps & Readonly<{ onDraftChange: CommentDraftChange }>) {
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('open');
  const [creating, setCreating] = useState(
    !paused && search.step !== undefined,
  );
  const filter =
    search.step === undefined
      ? { status, scope: 'all' as const }
      : { status, scope: 'step' as const, stepId: search.step };
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {creating || paused ? null : (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            New discussion
          </Button>
        )}
        <ToggleGroup
          aria-label="Discussion status"
          value={[status]}
          onValueChange={(values) => {
            const next: unknown = values[0];
            if (next === 'open' || next === 'resolved' || next === 'all')
              setStatus(next);
          }}
        >
          <ToggleGroupItem value="open">Open</ToggleGroupItem>
          <ToggleGroupItem value="resolved">Resolved</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </ToggleGroup>
      </div>
      {search.step === undefined ? null : (
        <p className="text-sm">
          Discussions for{' '}
          {steps.find((step) => step.id === search.step)?.label ??
            'a removed step'}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onNavigate({});
            }}
          >
            Show all
          </Button>
        </p>
      )}
      {creating ? (
        <section className="lens space-y-3 rounded-lg p-4">
          <CommentComposer
            scope={scope}
            onDraftChange={onDraftChange}
            target={{ kind: 'create', stepId: search.step ?? null, steps }}
            onCancel={() => {
              setCreating(false);
            }}
            onSaved={(result) => {
              setCreating(false);
              onNavigate({ thread: result.threadId });
            }}
          />
        </section>
      ) : null}
      <DiscussionThreads
        scope={scope}
        filter={filter}
        steps={steps}
        onOpen={(thread) => {
          onNavigate({ thread });
        }}
      />
    </>
  );
}

function useCommentDraftGuard() {
  const [drafts, setDrafts] = useState<ReadonlyMap<string, CommentDraftState>>(
    () => new Map(),
  );
  const current = useRef(drafts);
  const onDraftChange = useCallback<CommentDraftChange>((key, state) => {
    if (
      current.current.get(key) === state ||
      (state === 'clean' && !current.current.has(key))
    )
      return;
    const next = new Map(current.current);
    if (state === 'clean') next.delete(key);
    else next.set(key, state);
    current.current = next;
    setDrafts(next);
  }, []);
  const warnBeforeUnload = useCallback(() => current.current.size > 0, []);
  const shouldBlock = useCallback(
    ({
      current: from,
      next,
    }: {
      current: { pathname: string; search: object };
      next: { pathname: string; search: object };
    }) => {
      if (current.current.size === 0) return false;
      // Anchor changes keep the same discussion mounted; another thread does not.
      const previousThread: unknown = Reflect.get(from.search, 'thread');
      const nextThread: unknown = Reflect.get(next.search, 'thread');
      return from.pathname !== next.pathname || previousThread !== nextThread;
    },
    [],
  );
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: warnBeforeUnload,
    withResolver: true,
  });
  useEffect(() => {
    if (blocker.status === 'blocked' && current.current.size === 0)
      blocker.proceed();
  }, [blocker, drafts]);
  return {
    blocker,
    onDraftChange,
    unresolved: hasUnresolvedComments(drafts),
    uncertain: [...drafts.values()].includes('uncertain'),
    discard: () => {
      if (
        hasUnresolvedComments(current.current) ||
        blocker.status !== 'blocked'
      )
        return;
      const empty = new Map<string, CommentDraftState>();
      current.current = empty;
      setDrafts(empty);
      blocker.proceed();
    },
  };
}
function hasUnresolvedComments(
  drafts: ReadonlyMap<string, CommentDraftState>,
): boolean {
  return [...drafts.values()].some(
    (state) => state === 'saving' || state === 'uncertain',
  );
}
function CommentLeaveDialog({
  guard,
}: Readonly<{ guard: ReturnType<typeof useCommentDraftGuard> }>) {
  return (
    <Dialog
      open={guard.blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (!open && guard.blocker.status === 'blocked') guard.blocker.reset();
      }}
    >
      <DialogContent>
        <DialogTitle>
          {guard.unresolved
            ? 'Resolve the discussion change before leaving'
            : 'Discard the unfinished discussion?'}
        </DialogTitle>
        <DialogDescription>
          {commentLeaveReason(guard.unresolved, guard.uncertain)}
        </DialogDescription>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              if (guard.blocker.status === 'blocked') guard.blocker.reset();
            }}
          >
            Stay here
          </Button>
          {guard.unresolved ? null : (
            <Button variant="destructive" onClick={guard.discard}>
              Discard and leave
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function commentLeaveReason(unresolved: boolean, uncertain: boolean): string {
  if (!unresolved)
    return 'Your text and mentions will be discarded. Stay here to save them.';
  return uncertain
    ? 'This change may already be saved. Stay and retry the same action before leaving.'
    : 'A discussion change is being saved. Wait for confirmation before leaving.';
}
