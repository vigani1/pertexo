import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * The password requirement as a thread: it fills while people type and ties
 * a knot once the minimum length from the server's capabilities is met.
 */
export function PasswordMeter({
  id,
  length,
  minimumLength,
}: Readonly<{ id: string; length: number; minimumLength: number }>) {
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
            met ? 'from-success/30 to-success' : 'from-primary/30 to-primary',
          )}
        />
        <span
          className={cn(
            'absolute -top-1 -right-1 size-2.5 rounded-full bg-success transition-transform duration-300 ease-unspool motion-reduce:transition-none',
            met
              ? 'scale-100 shadow-[0_0_0_4px_color-mix(in_srgb,var(--success)_15%,transparent)]'
              : 'scale-0',
          )}
        />
      </div>
      <p id={id} className="font-mono text-[0.72rem] text-subtle-foreground">
        At least {minimumLength} characters ·{' '}
        <span className={cn(met && 'text-success')}>
          {Math.min(length, 999)} / {minimumLength}
        </span>
      </p>
      <span className="sr-only" aria-live="polite">
        {met ? 'Password is long enough.' : ''}
      </span>
    </div>
  );
}
