import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type CardChoice<Value extends string> = Readonly<{
  value: Value;
  label: string;
  hint: ReactNode;
  /** A small mark for the choice, drawn in a ring beside its label. */
  glyph: ReactNode;
  /** Unavailable now, though the others may still be chosen. */
  disabled?: boolean;
}>;

/**
 * Exclusive choices drawn as cards, two side by side when there is room.
 * Native radios keep arrow-key and form behavior.
 */
export function ChoiceCards<Value extends string>({
  legend,
  value,
  choices,
  disabled,
  onChange,
}: Readonly<{
  legend: string;
  value: Value;
  choices: readonly CardChoice<Value>[];
  disabled: boolean;
  onChange: (value: Value) => void;
}>) {
  const name = useId();
  return (
    <fieldset className="@container flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 @md:grid-cols-2">
        {choices.map((choice) => (
          <label
            key={choice.value}
            className={cn(
              'group relative flex cursor-pointer items-start gap-3 rounded-lg border bg-card/60 p-3 transition-colors motion-reduce:transition-none',
              // The radio is visually hidden, so its card carries the one focus ring.
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
              value === choice.value
                ? 'border-primary/60 bg-primary/5'
                : 'border-border hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name={name}
              value={choice.value}
              checked={value === choice.value}
              disabled={choice.disabled}
              className="sr-only"
              onChange={() => {
                onChange(choice.value);
              }}
            />
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border',
                value === choice.value
                  ? 'border-primary/50 text-primary'
                  : 'border-border text-muted-foreground',
              )}
            >
              {choice.glyph}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{choice.label}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {choice.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
