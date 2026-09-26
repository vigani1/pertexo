import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/** What the meter says: the rule, how far there is to go, or that it's met. */
function meterText(length: number, minimumLength: number): string {
  if (length === 0) return `At least ${String(minimumLength)} characters`;
  const missing = minimumLength - length;
  if (missing <= 0) return 'Long enough';
  return missing === 1
    ? '1 more character'
    : `${String(missing)} more characters`;
}

/**
 * The password requirement as a thread: it fills while people type and ties
 * a knot once the minimum length from the server's capabilities is met.
 * While the field shows a message of its own the words step aside, so the
 * rule isn't said twice.
 */
export function PasswordMeter({
  id,
  length,
  minimumLength,
  quiet = false,
}: Readonly<{
  id: string;
  length: number;
  minimumLength: number;
  quiet?: boolean;
}>) {
  const met = length >= minimumLength;
  const progress = Math.min(1, length / Math.max(1, minimumLength));
  return (
    <div
      data-slot="password-meter"
      data-state={met ? 'met' : 'short'}
      className="flex flex-col gap-1.5"
    >
      <div
        aria-hidden="true"
        className="relative mt-1 h-0.5 rounded-full bg-white/8"
      >
        <span
          style={
            { '--meter-fill': `${String(progress * 100)}%` } as CSSProperties
          }
          className={cn(
            'absolute inset-y-0 left-0 w-(--meter-fill) rounded-full bg-linear-to-r transition-[width] duration-300 ease-unspool motion-reduce:transition-none',
            met ? 'from-success/30 to-success' : 'from-action/30 to-action',
          )}
        />
        <span
          className={cn(
            'absolute -top-1 right-1 size-2.5 rounded-full bg-success transition-transform duration-300 ease-unspool motion-reduce:transition-none',
            met
              ? 'scale-100 shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_15%,transparent)]'
              : 'scale-0',
          )}
        />
      </div>
      <p
        id={id}
        hidden={quiet}
        className={cn(
          'font-mono text-[0.72rem] text-subtle-foreground',
          met && 'text-success',
        )}
      >
        {meterText(length, minimumLength)}
      </p>
      <span className="sr-only" aria-live="polite">
        {met ? 'Password is long enough.' : ''}
      </span>
    </div>
  );
}
