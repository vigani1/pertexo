import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/class-names';

const presentations = {
  live: ['running', 'Running'],
  success: ['succeeded', 'Succeeded'],
  failure: ['failed', 'Failed'],
  waiting: ['waiting', 'Waiting'],
  queued: ['queued', 'Queued'],
  attention: ['attention', 'Needs attention'],
  neutral: ['draft', 'Draft'],
  skipped: ['skipped', 'Skipped'],
  off: ['off', 'Off'],
  canceled: ['off', 'Canceled'],
  timeout: ['failed', 'Timed out'],
} as const;

export type StatusTone = keyof typeof presentations;

/** The state word can live elsewhere in a row. The mark has a name there. */
export function StatusMark({
  tone,
  still = false,
  display = 'word',
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> &
  Readonly<{
    tone: StatusTone;
    still?: boolean;
    display?: 'word' | 'mark';
    children?: ReactNode;
  }>) {
  const [state, word] = presentations[tone];
  return (
    <span
      data-slot="status"
      data-tone={tone}
      role={display === 'mark' ? 'img' : undefined}
      aria-label={display === 'mark' ? word : undefined}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-meta leading-none whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    >
      <span
        data-slot="status-glyph"
        data-state={state}
        data-still={still || undefined}
        aria-hidden="true"
        className="status-terminal"
      />
      {display === 'word' ? <span>{children ?? word}</span> : null}
    </span>
  );
}
