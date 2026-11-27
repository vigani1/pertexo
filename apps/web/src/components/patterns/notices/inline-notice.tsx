import type { ComponentProps, ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/class-names';
import {
  StatusMark,
  type StatusTone,
} from '@/components/patterns/status/status-mark';

export type NoticeTone = 'info' | 'success' | 'warning' | 'destructive';

const noticeVariants = cva(
  'flex items-start gap-3 rounded-lg px-3.5 py-3 text-label leading-snug text-muted-foreground',
  {
    variants: {
      tone: {
        info: 'bg-select-raised',
        success: 'bg-select-raised',
        warning: 'bg-warn-soft',
        destructive: 'bg-fail-soft',
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
      className={cn(
        noticeVariants({ tone }),
        thread === 'waiting' && 'bg-waiting-soft',
        className,
      )}
      {...props}
    >
      <StatusMark display="mark" tone={thread} className="mt-1" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        {title === undefined ? null : (
          <div className="font-semibold text-foreground">{title}</div>
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
