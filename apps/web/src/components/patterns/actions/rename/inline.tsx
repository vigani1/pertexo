import { CheckIcon, PencilIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { LabelledField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { Notice } from '@/components/ui/notice';
import { ProgressButton } from '@/components/ui/progress-button';
import { StatusGlyph } from '@/components/ui/status';
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
  Readonly<{
    /** `true` when the rename was saved, `false` when it was let go. */
    onClose: (saved: boolean) => void;
  }>) {
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
      if (done) onClose(true);
    });
  }

  function close() {
    command.dismiss();
    command.clearError();
    onClose(false);
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

  const accepted = command.accepted ?? false;
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
          refreshPending={command.refreshPending ?? false}
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

/** A key you could press instead: Enter saves, Escape lets go. */
const KEYCAP =
  'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-[5px] border px-1.5 font-mono text-[0.66rem] leading-none shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--surface-ink)_6%,transparent)] outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 motion-reduce:transition-none pointer-coarse:h-10 pointer-coarse:min-w-10 [&_svg]:size-3.5';

/**
 * The name edited where it stands. It lifts onto a glass plate, the same
 * size and face, written on a thread that draws in under it; Save and
 * Cancel are the keys that do them (↵ and esc, or ✓ and × on touch). The
 * plate floats over its surroundings, so nothing around it moves; only a
 * failure or a conflict adds a line below.
 */
function RenameInPlace({
  name,
  subject,
  label,
  command,
  onClose,
  onDraftChange,
  className,
  textClassName,
  ...rest
}: RenameFormProps &
  Readonly<{
    onClose: (saved: boolean) => void;
    onDraftChange?: ((draft: string) => void) | undefined;
    textClassName?: string | undefined;
  }>) {
  const id = useId();
  const rename = useRenameDraft({ name, command, onClose, ...rest });
  const error = rename.validation.error('name');
  const busy = command.pending || (command.refreshPending ?? false);
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
      {/* As wide as the name and its keys, so the plate hugs them. */}
      <div className="relative flex w-fit max-w-full min-w-0 items-center gap-1.5">
        {/* The plate the name is lifted onto while it's edited. */}
        <span
          aria-hidden="true"
          className="lens pointer-events-none absolute -inset-x-2.5 -inset-y-1.5 rounded-lg motion-safe:animate-[skeleton-in_0.18s_ease-out]"
        />
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
            // As wide as the name, so the keys stay beside it as it grows.
            style={{
              width: `${String(Math.max(rename.draft.length, 4) + 1)}ch`,
            }}
            className={cn(
              'block max-w-full min-w-0 bg-transparent p-0 text-foreground caret-action outline-none selection:bg-action/30 disabled:opacity-70',
              textClassName,
            )}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            onChange={(event) => {
              rename.change(event.currentTarget.value);
              onDraftChange?.(event.currentTarget.value);
            }}
          />
          {/* The thread the name is written on: it draws in as editing
              starts, light runs along it while saving, and it turns red
              on a name that can't be saved. */}
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-x-0 -bottom-0.5 h-px origin-left overflow-hidden rounded-full motion-safe:animate-fray',
              error === undefined ? 'bg-action/70' : 'bg-destructive',
              busy &&
                'after:absolute after:inset-y-0 after:left-[-45%] after:w-[45%] after:bg-linear-to-r after:from-transparent after:via-foreground after:to-transparent after:content-[""] motion-safe:after:animate-spool',
            )}
          />
        </span>
        {rename.conflict ? null : (
          <span className="relative flex items-center gap-1">
            <button
              type="submit"
              aria-label={saveLabel}
              title={`${saveLabel} (Enter)`}
              disabled={busy}
              className={cn(
                KEYCAP,
                'border-action/40 bg-action/[0.08] text-action hover:border-action/70',
              )}
            >
              {busy ? (
                <LoadingOrb />
              ) : command.retryAvailable || rename.accepted ? (
                <RotateCwIcon aria-hidden="true" />
              ) : (
                <>
                  <span aria-hidden="true" className="pointer-coarse:hidden">
                    ↵
                  </span>
                  <CheckIcon
                    aria-hidden="true"
                    className="hidden pointer-coarse:block"
                  />
                </>
              )}
            </button>
            {rename.accepted ? null : (
              <button
                type="button"
                aria-label="Cancel"
                title="Cancel (Esc)"
                disabled={command.pending}
                className={cn(
                  KEYCAP,
                  'border-border-strong bg-surface-ink/[0.04] text-muted-foreground hover:text-foreground',
                )}
                onClick={rename.close}
              >
                <span aria-hidden="true" className="pointer-coarse:hidden">
                  esc
                </span>
                <XIcon
                  aria-hidden="true"
                  className="hidden pointer-coarse:block"
                />
              </button>
            )}
          </span>
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
 * A name with a pencil that opens the rename in place. `children` is how
 * the name reads when not editing; render only `children` for people who
 * can't rename. A saved rename ties a knot at the end of the name.
 */
export function InlineRename({
  children,
  textClassName,
  onDraftChange,
  ...form
}: RenameFormProps &
  Readonly<{
    children: ReactNode;
    /** The name's type, so editing keeps its size, weight and face. */
    textClassName?: string;
    /** The name as typed, and `undefined` once editing ends. */
    onDraftChange?: (draft: string | undefined) => void;
  }>) {
  const [editing, setEditing] = useState(false);
  const [knotted, setKnotted] = useState(false);
  useEffect(() => {
    if (!knotted) return;
    const timer = window.setTimeout(() => {
      setKnotted(false);
    }, 2_400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [knotted]);
  if (editing)
    return (
      <RenameInPlace
        {...form}
        textClassName={textClassName}
        onDraftChange={onDraftChange}
        onClose={(saved) => {
          setEditing(false);
          setKnotted(saved);
          onDraftChange?.(undefined);
        }}
      />
    );
  return (
    <div className="group/rename flex min-w-0 items-center gap-1">
      {children}
      {knotted ? (
        // The new name is tied off with a knot for a moment.
        <span className="grid size-5 place-items-center text-success">
          <StatusGlyph tone="success" className="motion-safe:animate-knot" />
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${form.subject}`}
        className="text-subtle-foreground hover:text-foreground"
        onClick={() => {
          setKnotted(false);
          setEditing(true);
          onDraftChange?.(form.name);
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
