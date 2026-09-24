import { XIcon } from 'lucide-react';
import {
  Field,
  FieldControl,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@/components/ui/field';
import type { FieldThread } from '@/components/ui/use-field-validation';
import { cn } from '@/lib/utils';

/**
 * Several addresses as chips. Typing a comma, space or Enter turns the text
 * into chips; pasting a list works too. The caller owns the addresses and the
 * rule for what counts as one.
 */
export function EmailChipsField({
  id,
  emails,
  draft,
  disabled,
  error,
  thread,
  inputRef,
  onDraftChange,
  onCommit,
  onRemove,
}: Readonly<{
  id: string;
  emails: readonly string[];
  draft: string;
  disabled: boolean;
  error: string | undefined;
  thread: FieldThread;
  inputRef: (element: HTMLElement | null) => void;
  onDraftChange: (draft: string) => void;
  /** Turns the given text into chips, keeping anything that isn’t an address. */
  onCommit: (text: string) => void;
  onRemove: (email: string) => void;
}>) {
  const describedBy = [
    `${id}-description`,
    error === undefined ? '' : `${id}-error`,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Field data-invalid={error === undefined ? undefined : true}>
      <FieldLabel htmlFor={id}>Email addresses</FieldLabel>
      <FieldControl state={thread}>
        <div
          className={cn(
            'recessed-control flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 focus-within:border-primary',
            disabled && 'opacity-50',
          )}
        >
          {emails.map((email) => (
            <span
              key={email}
              className="inline-flex max-w-full items-center gap-1 rounded-sm bg-white/8 py-0.5 pr-0.5 pl-2 text-xs"
            >
              <span className="truncate">{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                disabled={disabled}
                className="grid size-5 place-items-center rounded-sm text-subtle-foreground hover:bg-white/10 hover:text-foreground"
                onClick={() => {
                  onRemove(email);
                }}
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            id={id}
            type="text"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            placeholder={emails.length === 0 ? 'name@company.com' : ''}
            disabled={disabled}
            value={draft}
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            className="min-w-40 flex-1 bg-transparent py-0.5 text-base outline-none placeholder:text-subtle-foreground md:text-sm"
            onChange={(event) => {
              const next = event.currentTarget.value;
              if (/[\s,;]$/u.test(next)) onCommit(next);
              else onDraftChange(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onCommit(draft);
              } else if (
                event.key === 'Backspace' &&
                draft === '' &&
                emails.length > 0
              ) {
                const last = emails.at(-1);
                if (last !== undefined) onRemove(last);
              }
            }}
            onBlur={() => {
              onCommit(draft);
            }}
          />
        </div>
      </FieldControl>
      <FieldDescription id={`${id}-description`}>
        Separate addresses with commas or spaces. Each person gets their own
        link, valid for seven days.
      </FieldDescription>
      {error === undefined ? null : (
        <FieldError id={`${id}-error`}>{error}</FieldError>
      )}
    </Field>
  );
}
