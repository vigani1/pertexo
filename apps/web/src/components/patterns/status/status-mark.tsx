import { cva, type VariantProps } from 'class-variance-authority';
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

const statusVariants = cva(
  'inline-flex shrink-0 items-center gap-1.5 leading-none whitespace-nowrap',
  {
    variants: {
      typography: {
        default: 'text-meta',
        label: 'font-sans text-label',
        emphasized: 'text-label font-medium',
        body: 'text-sm font-medium',
        caption: 'text-xs font-normal',
        count: 'font-mono text-meta',
        metadata: 'font-mono text-xs font-normal',
      },
      emphasis: {
        normal: 'text-muted-foreground',
        muted: 'text-subtle-foreground',
      },
    },
    defaultVariants: { typography: 'default', emphasis: 'normal' },
  },
);

/**
 * One status mark for every state. With `display="word"` the state word sits
 * beside the mark. A mark shown alone is decorative, because the words next to
 * it already say the state; give it a `label` only where it stands on its own,
 * taken from the caller's status label rather than from the tone.
 */
export function StatusMark({
  tone,
  still = false,
  display = 'word',
  label,
  typography,
  emphasis,
  className,
  children,
  ...props
}: Omit<ComponentProps<'span'>, 'children'> &
  VariantProps<typeof statusVariants> &
  Readonly<{
    tone: StatusTone;
    still?: boolean;
    display?: 'word' | 'mark';
    /** Names a mark that stands alone; ignored when the word is shown. */
    label?: string;
    children?: ReactNode;
  }>) {
  const [state, word] = presentations[tone];
  const named = display === 'mark' && label !== undefined;
  return (
    <span
      data-slot="status"
      data-tone={tone}
      role={named ? 'img' : undefined}
      aria-label={named ? label : undefined}
      aria-hidden={display === 'mark' && !named ? true : undefined}
      className={cn(statusVariants({ typography, emphasis }), className)}
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
