import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { StatusGlyph } from './status';

export type NoticeTone = 'success' | 'attention' | 'failure' | 'neutral';

const SURFACE: Readonly<Record<NoticeTone, string>> = {
  success: 'border-success/20 bg-success/5',
  attention: 'border-warning/25 bg-warning/5',
  failure: 'border-destructive/25 bg-destructive/5',
  neutral: 'border-border bg-white/[0.03]',
};

const GLYPH_COLOR: Readonly<Record<NoticeTone, string>> = {
  success: 'text-success',
  attention: 'text-warning',
  failure: 'text-destructive',
  neutral: 'text-muted-foreground',
};

/**
 * An inline message that stays put: what happened and what to do next, led by
 * the status glyph for its tone. Callers add `role="alert"` for failures that
 * must be announced.
 */
export function Notice({
  tone = 'neutral',
  title,
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & {
  tone?: NoticeTone;
  title?: ReactNode;
}) {
  return (
    <div
      data-slot="notice"
      data-tone={tone}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm text-foreground',
        SURFACE[tone],
        className,
      )}
      {...props}
    >
      <StatusGlyph tone={tone} className={cn('mt-0.5', GLYPH_COLOR[tone])} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {title === undefined ? null : <p className="font-semibold">{title}</p>}
        {children === undefined ? null : (
          <div className={cn(title !== undefined && 'text-muted-foreground')}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}
