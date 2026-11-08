import { Notice } from '@/components/ui/notice';
import { formatShortTime } from '@/lib/format/time';
import { useOnlineStatus } from '@/lib/hooks/use-online-status';
import { cn } from '@/lib/class-names';
import type { EditorState } from '../../model/state/workflow-editor.store';
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
        recovery={'recovery' in save ? save.recovery : undefined}
        onRetry={onRetry}
        onReview={onReview}
      />
    </span>
  );
}

// One editor session renders the status and its banner together.
const SAVE_FAILURE_REASON_ID = 'editor-save-failure-reason';

export function SaveFailureNotice() {
  const save = useEditorStore((state) => state.save);
  if (save.status !== 'failed' && save.status !== 'uncertain') return null;
  const recovery = save.recovery ?? 'retry';
  return (
    <Notice
      id={SAVE_FAILURE_REASON_ID}
      role="alert"
      tone={save.status === 'uncertain' ? 'warning' : 'destructive'}
      className="[overflow-wrap:anywhere]"
    >
      <span>{save.error}</span>
      {recovery === 'retry' ? null : (
        <span className="block text-sm">{saveRecoveryAdvice(recovery)}</span>
      )}
    </Notice>
  );
}

function Sentence({
  status,
  online,
  savedAt,
  error,
  onRetry,
  onReview,
  recovery,
}: Readonly<{
  recovery?: 'retry' | 'access' | 'edit' | 'wait' | undefined;
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
        <SaveFailure
          status={status}
          recovery={recovery}
          error={error}
          onRetry={onRetry}
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
        'inline-flex min-w-0 flex-wrap items-center gap-1',
        tone === 'warning' ? 'text-warning' : 'text-destructive',
      )}
    >
      <span>{label} ·</span>
      <button
        type="button"
        className="inline-flex shrink-0 items-center underline decoration-current/40 underline-offset-2 outline-none hover:decoration-current focus-ring pointer-coarse:min-h-10"
        onClick={onClick}
        aria-describedby={
          title === undefined ? undefined : SAVE_FAILURE_REASON_ID
        }
      >
        {action}
      </button>
    </span>
  );
}

function saveRecoveryAdvice(recovery: 'access' | 'edit' | 'wait'): string {
  if (recovery === 'access')
    return 'Ask a workspace owner to restore editing access. Your changes are kept here.';
  if (recovery === 'edit')
    return 'Correct the step setup to save your draft. Your changes are kept here.';
  return 'Saving resumes automatically after the wait.';
}

function SaveFailure({
  status,
  recovery,
  error,
  onRetry,
}: Readonly<{
  status: 'failed' | 'uncertain';
  recovery?: 'retry' | 'access' | 'edit' | 'wait' | undefined;
  error: string | null;
  onRetry: () => void;
}>) {
  if (recovery !== undefined && recovery !== 'retry')
    return (
      <span className="text-destructive" title={error ?? undefined}>
        Couldn’t save
      </span>
    );
  return (
    <InlineAction
      tone={status === 'failed' ? 'destructive' : 'warning'}
      label={status === 'failed' ? 'Couldn’t save' : 'Save unconfirmed'}
      action="Retry"
      title={error ?? undefined}
      onClick={onRetry}
    />
  );
}
