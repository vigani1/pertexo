import type { ComponentProps, ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';
import { StatusGlyph, type StatusTone } from './status';
import { statusToneText } from './status-tone';

export type NoticeTone = 'info' | 'success' | 'warning' | 'destructive';

const noticeVariants = cva(
  'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-snug text-foreground',
  {
    variants: {
      tone: {
        info: 'border-border bg-white/[0.03]',
        success: 'border-success/25 bg-success/6',
        warning: 'border-warning/25 bg-warning/6',
        destructive: 'border-destructive/30 bg-destructive/8',
      },
    },
  },
);

const TONE_GLYPH: Readonly<Record<NoticeTone, StatusTone>> = {
  info: 'neutral',
  success: 'success',
  warning: 'attention',
  destructive: 'failure',
};

/**
 * An inline message that stays put — a failed command, an uncertain outcome,
 * a lasting state — led by the status glyph for its tone. Destructive notices
 * are alerts; the rest are polite statuses. `glyph` keeps a more specific
 * thread (waiting, timed out) where the status language has one.
 */
export function Notice({
  tone = 'info',
  glyph,
  title,
  action,
  role = tone === 'destructive' ? 'alert' : 'status',
  className,
  children,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> &
  Readonly<{
    tone?: NoticeTone;
    glyph?: StatusTone | undefined;
    title?: ReactNode;
    /** One follow-up control under the message, e.g. "Try again". */
    action?: ReactNode;
  }>) {
  const thread = glyph ?? TONE_GLYPH[tone];
  return (
    <div
      role={role}
      data-slot="notice"
      data-tone={tone}
      className={cn(noticeVariants({ tone }), className)}
      {...props}
    >
      <StatusGlyph
        tone={thread}
        className={cn('mt-px', statusToneText[thread])}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        {title === undefined ? null : (
          <div className="font-semibold">{title}</div>
        )}
        {children === undefined ? null : (
          <div className={cn(title !== undefined && 'text-muted-foreground')}>
            {children}
          </div>
        )}
        {action}
      </div>
    </div>
  );
}
