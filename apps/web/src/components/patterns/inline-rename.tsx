import { PencilIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { useFieldValidation } from '@/components/ui/use-field-validation';
import { cn } from '@/lib/utils';

export type InlineRenameError = Readonly<{
  kind: 'conflict' | 'other' | 'verification';
  message: string;
}>;

/**
 * What a feature's rename command offers the field. A conflict loads the
 * latest name (`reloadLatest`) so people choose between theirs and it; an
 * unconfirmed attempt is sent again exactly (`retry`). Commands whose page
 * may lag behind an accepted rename also offer `refresh`.
 */
export type InlineRenameCommand = Readonly<{
  pending: boolean;
  error: InlineRenameError | undefined;
  retryAvailable: boolean;
  retry: () => Promise<boolean>;
  reloadLatest: () => Promise<boolean>;
  dismiss: () => void;
  clearError: () => void;
  accepted?: boolean;
  refreshPending?: boolean;
  refresh?: () => Promise<boolean>;
}>;

type RenameFormProps = Readonly<{
  name: string;
  revision: number;
  /** What is renamed, e.g. "workflow": "Rename workflow", "This workflow changed…". */
  subject: string;
  label: string;
  /** The message for an invalid name, e.g. its length. */
  validate: (name: string) => string | undefined;
  command: InlineRenameCommand;
  /**
   * Sends the rename and resolves `true` once it is confirmed; the command
   * reports pending, conflicts and retries meanwhile.
   */
  onSave: (name: string, expectedRevision: number) => Promise<boolean>;
  /** Layout of the form, e.g. a row in a bar. */
  className?: string;
}>;

/**
 * The rename form: the field, then Save and Cancel. Save sends the revision
 * the edit started from; if someone renamed it meanwhile, people choose
 * between their name and the newer one ("Use theirs / Keep mine"). A
 * confirmed rename, Cancel and Escape all call `onClose`.
 */
export function RenameForm({
  name,
  revision,
  subject,
  label,
  validate,
  command,
  onSave,
  onClose,
  className,
}: RenameFormProps & Readonly<{ onClose: () => void }>) {
  const id = useId();
  const [startedAs] = useState(name);
  // The revision people last saw: where the edit started, or the newer one
  // they chose to replace with "Keep mine". A background refresh never moves it.
  const [baseRevision, setBaseRevision] = useState(revision);
  const [submittedRevision, setSubmittedRevision] = useState<number>();
  const [draft, setDraft] = useState(name);
  const validation = useFieldValidation<'name'>();

  /** A confirmed rename closes the form; anything else keeps it open. */
  function settle(confirmed: Promise<boolean> | undefined) {
    void confirmed?.then((done) => {
      if (done) onClose();
    });
  }

  function close() {
    command.dismiss();
    command.clearError();
    onClose();
  }

  function save(expectedRevision: number) {
    if (!validation.submit({ name: validate(draft) })) return;
    const trimmed = draft.trim();
    if (trimmed === name && expectedRevision === revision) {
      close();
      return;
    }
    setDraft(trimmed);
    setBaseRevision(expectedRevision);
    setSubmittedRevision(expectedRevision);
    settle(onSave(trimmed, expectedRevision));
  }

  const accepted = command.accepted === true;
  const conflict = command.error?.kind === 'conflict';
  const latestLoaded =
    conflict &&
    submittedRevision !== undefined &&
    revision !== submittedRevision;
  const locked = command.pending || command.retryAvailable || accepted;

  return (
    <form
      noValidate
      className={cn('flex max-w-xl min-w-0 flex-col gap-3', className)}
      onSubmit={(event) => {
        event.preventDefault();
        if (command.retryAvailable) settle(command.retry());
        else if (accepted) settle(command.refresh?.());
        else save(baseRevision);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !locked) close();
      }}
    >
      <LabelledField
        id={`${id}-name`}
        label={label}
        error={validation.error('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={validation.register('name')}
            autoComplete="off"
            autoFocus
            maxLength={128}
            value={draft}
            disabled={locked}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setDraft(next);
              command.clearError();
              validation.change('name', validate(next));
            }}
          />
        )}
      </LabelledField>
      {command.error === undefined ? null : (
        <Notice
          role="alert"
          tone={conflict || command.retryAvailable ? 'warning' : 'destructive'}
        >
          {latestLoaded
            ? meanwhileMessage(name, startedAs, subject)
            : command.error.message}
        </Notice>
      )}
      {conflict ? (
        <ConflictActions
          latestLoaded={latestLoaded}
          onUseTheirs={close}
          onKeepMine={() => {
            command.clearError();
            save(revision);
          }}
          onLoadLatest={() => {
            void command.reloadLatest();
          }}
        />
      ) : (
        <SaveActions
          accepted={accepted}
          pending={command.pending}
          refreshPending={command.refreshPending === true}
          retryAvailable={command.retryAvailable}
          onCancel={close}
        />
      )}
    </form>
  );
}

/**
 * A name with a pencil that opens the rename form in place. `children` is
 * how the name reads when not editing; render only `children` for people
 * who can't rename.
 */
export function InlineRename({
  children,
  ...form
}: RenameFormProps & Readonly<{ children: ReactNode }>) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <RenameForm
        {...form}
        onClose={() => {
          setEditing(false);
        }}
      />
    );
  return (
    <div className="flex min-w-0 items-center gap-2">
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${form.subject}`}
        onClick={() => {
          setEditing(true);
        }}
      >
        <PencilIcon aria-hidden="true" />
      </Button>
    </div>
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

function SaveActions({
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
