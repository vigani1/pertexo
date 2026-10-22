import { useId } from 'react';
import { LockIcon, UsersIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type Mode = 'workspace' | 'restricted';

/**
 * Two exclusive choices drawn as cards: everyone in the workspace, or only
 * the people listed below. Native radios keep arrow-key and form behavior.
 */
export function SharingModeChoice({
  legend,
  value,
  everyone,
  restricted,
  disabled,
  onChange,
}: Readonly<{
  legend: string;
  value: Mode;
  everyone: Readonly<{ label: string; hint: string }>;
  restricted: Readonly<{ label: string; hint: string }>;
  disabled: boolean;
  onChange: (mode: Mode) => void;
}>) {
  const name = useId();
  const choices = [
    { mode: 'workspace' as const, icon: UsersIcon, ...everyone },
    { mode: 'restricted' as const, icon: LockIcon, ...restricted },
  ];
  return (
    <fieldset className="@container flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 @md:grid-cols-2">
        {choices.map(({ mode, icon: Icon, label, hint }) => (
          <label
            key={mode}
            className={cn(
              'group relative flex cursor-pointer items-start gap-3 rounded-lg border bg-card/60 p-3 transition-colors motion-reduce:transition-none',
              // The radio is visually hidden, so its card carries the one focus ring.
              'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring',
              'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
              value === mode
                ? 'border-primary/60 bg-primary/5'
                : 'border-border hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name={name}
              value={mode}
              checked={value === mode}
              className="sr-only"
              onChange={() => {
                onChange(mode);
              }}
            />
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 grid size-7 shrink-0 place-items-center rounded-full border',
                value === mode
                  ? 'border-primary/50 text-primary'
                  : 'border-border text-muted-foreground',
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium">{label}</span>
              <span className="text-xs leading-relaxed text-muted-foreground">
                {hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
