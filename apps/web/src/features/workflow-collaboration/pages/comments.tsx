import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CollaborationScope } from '../data/collaboration.api';
import { CommentComposer } from '../components/composer';
import { WorkflowDiscussion } from '../components/discussion';
import { DiscussionThreads } from '../components/thread-list';
interface Search {
  thread?: string | undefined;
  comment?: string | undefined;
  step?: string | undefined;
}
interface PageProps {
  scope: CollaborationScope;
  steps: readonly { id: string; label: string }[];
  search: Search;
  onNavigate: (search: Search) => void;
}
export function WorkflowCommentsPage(props: PageProps) {
  const { scope, steps, search, onNavigate } = props;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="eyebrow">Together, one thread at a time</p>
        <h2 className="font-display text-3xl">Comments</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Discuss the workflow or a step. Mention a teammate to bring them into
          the thread.
        </p>
      </div>
      {search.thread === undefined ? (
        <ThreadOverview {...props} />
      ) : (
        <WorkflowDiscussion
          key={search.thread}
          scope={scope}
          threadId={search.thread}
          anchor={search.comment}
          steps={steps}
          onClose={() => {
            onNavigate(search.step === undefined ? {} : { step: search.step });
          }}
          onLatest={() => {
            onNavigate({ thread: search.thread });
          }}
        />
      )}
    </div>
  );
}
function ThreadOverview({ scope, steps, search, onNavigate }: PageProps) {
  const [status, setStatus] = useState<'all' | 'open' | 'resolved'>('open');
  const [creating, setCreating] = useState(search.step !== undefined);
  const filter =
    search.step === undefined
      ? { status, scope: 'all' as const }
      : { status, scope: 'step' as const, stepId: search.step };
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {creating ? null : (
          <Button
            onClick={() => {
              setCreating(true);
            }}
          >
            New discussion
          </Button>
        )}
        <label className="text-sm">
          Show{' '}
          <select
            aria-label="Discussion status"
            className="ml-2 rounded border border-border bg-background p-2"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as typeof status);
            }}
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All discussions</option>
          </select>
        </label>
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
