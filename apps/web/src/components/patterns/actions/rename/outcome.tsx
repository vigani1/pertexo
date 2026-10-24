import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import type { InlineRenameCommand } from './contract';
import type { useRenameDraft } from './use-draft';

/** A failed or conflicting save: the message, and for a conflict the choice. */
export function RenameOutcome({
  name,
  subject,
  command,
  rename,
}: Readonly<{
  name: string;
  subject: string;
  command: InlineRenameCommand;
  rename: ReturnType<typeof useRenameDraft>;
}>) {
  return (
    <>
      {command.error === undefined ? null : (
        <Notice
          role="alert"
          tone={
            rename.conflict || command.retryAvailable
              ? 'warning'
              : 'destructive'
          }
        >
          {rename.latestLoaded
            ? meanwhileMessage(name, rename.startedAs, subject)
            : command.error.message}
        </Notice>
      )}
      {rename.conflict ? (
        <ConflictActions
          latestLoaded={rename.latestLoaded}
          onUseTheirs={rename.close}
          onKeepMine={rename.keepMine}
          onLoadLatest={() => {
            void command.reloadLatest();
          }}
        />
      ) : null}
    </>
  );
}

function meanwhileMessage(
  current: string,
  startedAs: string,
  subject: string,
): string {
  return current === startedAs
    ? `This ${subject} changed while you were editing.`
    : `Renamed to “${current}” meanwhile.`;
}

/** Someone renamed it meanwhile: load their name, then keep either. */
function ConflictActions({
  latestLoaded,
  onUseTheirs,
  onKeepMine,
  onLoadLatest,
}: Readonly<{
  latestLoaded: boolean;
  onUseTheirs: () => void;
  onKeepMine: () => void;
  onLoadLatest: () => void;
}>) {
  if (!latestLoaded)
    return (
      <Button
        type="button"
        variant="default"
        className="self-start"
        onClick={onLoadLatest}
      >
        Load the latest name
      </Button>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="ghost" onClick={onUseTheirs}>
        Use theirs
      </Button>
      <Button type="button" variant="default" onClick={onKeepMine}>
        Keep mine
      </Button>
    </div>
  );
}

export function SaveActions({
  accepted,
  pending,
  refreshPending,
  retryAvailable,
  onCancel,
}: Readonly<{
  accepted: boolean;
  pending: boolean;
  refreshPending: boolean;
  retryAvailable: boolean;
  onCancel: () => void;
}>) {
  let label = 'Save';
  if (retryAvailable) label = 'Try again';
  else if (accepted) label = 'Refresh';
  // Like every dialog's footer: Cancel then the filled commit, on the right.
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {accepted ? null : (
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
      )}
      <ProgressButton
        type="submit"
        variant="primary"
        pending={pending || refreshPending}
        pendingLabel={pending ? 'Saving…' : 'Refreshing…'}
      >
        {label}
      </ProgressButton>
    </div>
  );
}
