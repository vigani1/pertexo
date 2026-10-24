import { CheckIcon, RotateCwIcon, XIcon } from 'lucide-react';
import { useId } from 'react';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { cn } from '@/lib/utils';
import type { RenameFormProps } from './contract';
import { useRenameDraft } from './use-draft';
import { RenameOutcome } from './outcome';

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
export function RenameInPlace({
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
              <RenameSaveIcon
                pending={busy}
                retryAvailable={command.retryAvailable}
                accepted={rename.accepted}
              />
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

function RenameSaveIcon({
  pending,
  retryAvailable,
  accepted,
}: Readonly<{ pending: boolean; retryAvailable: boolean; accepted: boolean }>) {
  return pending ? (
    <LoadingOrb />
  ) : retryAvailable || accepted ? (
    <RotateCwIcon aria-hidden="true" />
  ) : (
    <>
      <span aria-hidden="true" className="pointer-coarse:hidden">
        ↵
      </span>
      <CheckIcon aria-hidden="true" className="hidden pointer-coarse:block" />
    </>
  );
}
