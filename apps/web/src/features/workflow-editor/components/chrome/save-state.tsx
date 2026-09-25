import { formatShortTime } from '@/lib/format-time';
import { cn } from '@/lib/utils';
import type { EditorState } from '../../model/editor.store';
import { useEditorStore } from '../../model/editor-store-context';

/**
 * The save state as a sentence under the workflow name: Saved 14:31,
 * Saving…, Unsaved, Couldn't save · Retry, Changed elsewhere · Review.
 * Failures read as destructive and conflicts as a warning, never lavender.
 */
export function SaveState({
  onRetry,
  onReview,
}: Readonly<{ onRetry: () => void; onReview: () => void }>) {
  const saveStatus = useEditorStore((state) => state.saveStatus);
  const savedAt = useEditorStore((state) => state.savedAt);
  const scratch = useEditorStore((state) => state.inspectorScratch);
  const saveError = useEditorStore((state) => state.saveError);
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex min-w-0 items-center gap-1"
    >
      <span aria-hidden="true">·</span>
      <Sentence
        status={scratch && saveStatus === 'clean' ? 'dirty' : saveStatus}
        savedAt={savedAt}
        error={saveError}
        onRetry={onRetry}
        onReview={onReview}
      />
    </span>
  );
}

function Sentence({
  status,
  savedAt,
  error,
  onRetry,
  onReview,
}: Readonly<{
  status: EditorState['saveStatus'];
  savedAt: string | null;
  error: string | null;
  onRetry: () => void;
  onReview: () => void;
}>) {
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
          label={
            status === 'failed' ? 'Couldn’t save' : 'Couldn’t confirm the save'
          }
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
      className={cn(tone === 'warning' ? 'text-warning' : 'text-destructive')}
    >
      {label} ·{' '}
      <button
        type="button"
        className="underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={onClick}
      >
        {action}
      </button>
    </span>
  );
}
