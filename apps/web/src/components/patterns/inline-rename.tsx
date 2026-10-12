import { CheckIcon, PencilIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
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
 * What both rename forms share: the draft, its validation, the revision the
 * edit started from and how a save, a conflict or a retry settles.
 */
function useRenameDraft({
  name,
  revision,
  validate,
  command,
  onSave,
  onClose,
}: Pick<
  RenameFormProps,
  'name' | 'revision' | 'validate' | 'command' | 'onSave'
> &
  Readonly<{ onClose: () => void }>) {
  const [startedAs] = useState(name);
  // The revision people last saw: where the edit started, or the newer one
  // they chose to replace with "Keep mine". A background refresh never moves it.
  // The revision the next save starts from; handlers read it, nothing draws it.
  const baseRevision = useRef(revision);
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
    baseRevision.current = expectedRevision;
    setSubmittedRevision(expectedRevision);
    settle(onSave(trimmed, expectedRevision));
  }

  const accepted = command.accepted === true;
  const conflict = command.error?.kind === 'conflict';
  return {
    draft,
    validation,
    accepted,
    conflict,
    latestLoaded:
      conflict &&
      submittedRevision !== undefined &&
      revision !== submittedRevision,
    locked: command.pending || command.retryAvailable || accepted,
    startedAs,
    close,
    change: (next: string) => {
      setDraft(next);
      command.clearError();
      validation.change('name', validate(next));
    },
    submit: () => {
      if (command.retryAvailable) settle(command.retry());
      else if (accepted) settle(command.refresh?.());
      else save(baseRevision.current);
    },
    keepMine: () => {
      command.clearError();
      save(revision);
    },
  };
}

/**
 * The rename form: the field, then Save and Cancel. Save sends the revision
 * the edit started from; if someone renamed it meanwhile, people choose
 * between their name and the newer one ("Use theirs / Keep mine"). A
 * confirmed rename, Cancel and Escape all call `onClose`.
 */
export function RenameForm({
  name,
  subject,
  label,
  command,
  onClose,
  className,
  ...rest
}: RenameFormProps & Readonly<{ onClose: () => void }>) {
  const id = useId();
  const rename = useRenameDraft({ name, command, onClose, ...rest });
  return (
    <form
      noValidate
      className={cn('flex max-w-xl min-w-0 flex-col gap-3', className)}
      onSubmit={(event) => {
        event.preventDefault();
        rename.submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !rename.locked) rename.close();
      }}
    >
      <LabelledField
        id={`${id}-name`}
        label={label}
        error={rename.validation.error('name')}
      >
        {(control) => (
          <Input
            {...control}
            ref={rename.validation.register('name')}
            autoComplete="off"
            autoFocus
            maxLength={128}
            value={rename.draft}
            disabled={rename.locked}
            onChange={(event) => {
              rename.change(event.currentTarget.value);
            }}
          />
        )}
      </LabelledField>
      <RenameOutcome
        name={name}
        subject={subject}
        command={command}
        rename={rename}
      />
      {rename.conflict ? null : (
        <SaveActions
          accepted={rename.accepted}
          pending={command.pending}
          refreshPending={command.refreshPending === true}
          retryAvailable={command.retryAvailable}
          onCancel={rename.close}
        />
      )}
    </form>
  );
}

/** A failed or conflicting save: the message, and for a conflict the choice. */
function RenameOutcome({
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

/**
 * The name edited where it stands: the same type on a thread that draws in
 * under it, with Save and Cancel as marks beside it, so nothing around it
 * moves. Only a failure or a conflict adds a line below.
 */
function RenameInPlace({
  name,
  subject,
  label,
  command,
  onClose,
  className,
  textClassName,
  ...rest
}: RenameFormProps &
  Readonly<{ onClose: () => void; textClassName?: string | undefined }>) {
  const id = useId();
  const rename = useRenameDraft({ name, command, onClose, ...rest });
  const error = rename.validation.error('name');
  const busy = command.pending || command.refreshPending === true;
  let saveLabel = 'Save';
  if (command.retryAvailable) saveLabel = 'Try again';
  else if (rename.accepted) saveLabel = 'Refresh';
  return (
    <form
      noValidate
      className={cn('flex min-w-0 flex-col gap-2', className)}
      onSubmit={(event) => {
        event.preventDefault();
        rename.submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !rename.locked) rename.close();
      }}
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="relative min-w-0">
          <label htmlFor={`${id}-name`} className="sr-only">
            {label}
          </label>
          <input
            id={`${id}-name`}
            ref={rename.validation.register('name')}
            autoComplete="off"
            autoFocus
            maxLength={128}
            value={rename.draft}
            disabled={rename.locked}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : `${id}-error`}
            // As wide as the name, so the marks stay beside it as it grows.
            style={{
              width: `${String(Math.max(rename.draft.length, 4) + 1)}ch`,
            }}
            className={cn(
              'block max-w-full min-w-0 bg-transparent p-0 text-foreground caret-action outline-none disabled:opacity-70',
              textClassName,
            )}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              rename.change(event.currentTarget.value);
            }}
          />
          {/* The thread the name is written on: it draws in as editing
              starts, light runs along it while saving, and it turns red
              on a name that can't be saved. */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 -bottom-1 h-px origin-left overflow-hidden rounded-full motion-safe:animate-fray',
              error === undefined ? 'bg-action/70' : 'bg-destructive',
              busy &&
                'after:absolute after:inset-y-0 after:left-[-45%] after:w-[45%] after:bg-linear-to-r after:from-transparent after:via-foreground after:to-transparent after:content-[""] motion-safe:after:animate-spool',
            )}
          />
        </span>
        {rename.conflict ? null : (
          <>
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label={saveLabel}
              title={saveLabel}
              disabled={busy}
              className="text-action"
            >
              {busy ? (
                <LoadingOrb />
              ) : command.retryAvailable || rename.accepted ? (
                <RotateCwIcon aria-hidden="true" />
              ) : (
                <CheckIcon aria-hidden="true" />
              )}
            </Button>
            {rename.accepted ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Cancel"
                title="Cancel (Esc)"
                disabled={command.pending}
                onClick={rename.close}
              >
                <XIcon aria-hidden="true" />
              </Button>
            )}
          </>
        )}
      </div>
      {error === undefined ? null : (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
      <RenameOutcome
        name={name}
        subject={subject}
        command={command}
        rename={rename}
      />
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
  textClassName,
  ...form
}: RenameFormProps &
  Readonly<{
    children: ReactNode;
    /** The name's type, so editing keeps its size, weight and face. */
    textClassName?: string;
  }>) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <RenameInPlace
        {...form}
        textClassName={textClassName}
        onClose={() => {
          setEditing(false);
        }}
      />
    );
  return (
    <div className="group/rename flex min-w-0 items-center gap-1">
      {children}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${form.subject}`}
        className="text-subtle-foreground hover:text-foreground"
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
