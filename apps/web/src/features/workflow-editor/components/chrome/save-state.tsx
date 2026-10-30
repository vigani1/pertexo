import { formatShortTime } from '@/lib/format/time';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { cn } from '@/lib/utils';
import type { EditorState } from '../../model/state/store';
import { useEditorStore } from '../../model/state/context';

/**
 * The save state as a sentence under the workflow name: Saved 14:31,
 * Saving…, Unsaved, Couldn't save · Retry, Changed elsewhere · Review, and
 * Offline · changes kept while unsaved work waits for the connection.
 * Reserve room for recovery actions so changing the sentence cannot move
 * the header. Failures read as destructive and conflicts as a warning.
 */
export function SaveState({
  onRetry,
  onReview,
}: Readonly<{ onRetry: () => void; onReview: () => void }>) {
  const save = useEditorStore((state) => state.save);
  const savedAt = useEditorStore((state) => state.savedAt);
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const online = useOnlineStatus();
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex h-9 w-44 min-w-0 max-w-full shrink-0 max-sm:flex-1 max-sm:min-h-11 items-center gap-1 pointer-coarse:h-10"
    >
      <span aria-hidden="true">·</span>
      <Sentence
        status={scratch && save.status === 'clean' ? 'dirty' : save.status}
        online={online}
        savedAt={savedAt}
        error={'error' in save ? save.error : null}
        onRetry={onRetry}
        onReview={onReview}
      />
    </span>
  );
}

function Sentence({
  status,
  online,
  savedAt,
  error,
  onRetry,
  onReview,
}: Readonly<{
  status: EditorState['save']['status'];
  online: boolean;
  savedAt: string | null;
  error: string | null;
  onRetry: () => void;
  onReview: () => void;
}>) {
  // Retry can't help without a connection; saving resumes on reconnect.
  if (!online && status !== 'clean' && status !== 'conflict')
    return (
      <span
        className="text-warning"
        title="Your changes save when the connection returns."
      >
        Offline · changes kept
      </span>
    );
  switch (status) {
    case 'clean':
      return savedAt === null ? (
        <span>Saved</span>
      ) : (
        <span>
          Saved <time dateTime={savedAt}>{formatShortTime(savedAt)}</time>
        </span>
      );
    case 'saving':
      return <span>Saving…</span>;
    case 'conflict':
      return (
        <InlineAction
          tone="warning"
          label="Changed elsewhere"
          action="Review"
          onClick={onReview}
        />
      );
    case 'failed':
    case 'uncertain':
      return (
        <InlineAction
          tone={status === 'failed' ? 'destructive' : 'warning'}
          label={status === 'failed' ? 'Couldn’t save' : 'Save unconfirmed'}
          action="Retry"
          title={error ?? undefined}
          onClick={onRetry}
        />
      );
    case 'dirty':
      return <span>Unsaved</span>;
  }
}

function InlineAction({
  tone,
  label,
  action,
  title,
  onClick,
}: Readonly<{
  tone: 'warning' | 'destructive';
  label: string;
  action: string;
  title?: string | undefined;
  onClick: () => void;
}>) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-w-0 items-center gap-1',
        tone === 'warning' ? 'text-warning' : 'text-destructive',
      )}
    >
      <span>{label} ·</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-ring pointer-coarse:min-h-10"
        onClick={onClick}
      >
        {action}
      </button>
    </span>
  );
}
