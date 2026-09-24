import type { ComponentProps, ReactNode } from 'react';
import { StatusGlyph, type StatusTone } from '@/components/ui/status';
import { cn } from '@/lib/utils';

/**
 * The glass lens that floats over the stage. While a request is in flight it
 * carries the live edge; nothing moves when nothing is happening.
 */
export function AuthLens({
  pending = false,
  className,
  ...props
}: ComponentProps<'section'> & { pending?: boolean }) {
  return (
    <section
      data-slot="auth-lens"
      aria-busy={pending || undefined}
      className={cn(
        'lens relative flex w-full max-w-[25.25rem] flex-col rounded-xl px-6 pt-7 pb-6 sm:px-7.5 sm:pt-7.5',
        pending && 'live-edge',
        className,
      )}
      {...props}
    />
  );
}

export function AuthLensTitle({ className, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      className={cn(
        'text-[1.875rem] leading-none font-semibold tracking-[-0.03em]',
        className,
      )}
      {...props}
    />
  );
}

export function AuthLensDescription({
  className,
  ...props
}: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mt-2 text-[0.85rem] leading-relaxed text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

/** The quiet line under the form: "New to Pertexo? Create an account". */
export function AuthLensFooter({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      className={cn(
        'mt-5 text-center text-[0.8rem] text-subtle-foreground [&_a]:font-semibold [&_a]:text-accent-foreground [&_a]:underline-offset-4 [&_a:hover]:underline',
        className,
      )}
      {...props}
    />
  );
}

const LINE_TONE: Partial<Record<StatusTone, string>> = {
  success: 'border-success/25 bg-success/6',
  failure: 'border-destructive/30 bg-destructive/8',
  timeout: 'border-destructive/25 bg-destructive/6',
  attention: 'border-warning/25 bg-warning/6',
  live: 'border-primary/25 bg-primary/6',
  waiting: 'border-secondary/25 bg-secondary/6',
};

const GLYPH_TONE: Partial<Record<StatusTone, string>> = {
  success: 'text-success',
  failure: 'text-destructive',
  timeout: 'text-destructive',
  attention: 'text-warning',
  live: 'text-primary',
  waiting: 'text-secondary',
};

/**
 * One sentence of feedback inside the lens, led by its status glyph. Failures
 * are alerts; everything else is a polite status.
 */
export function AuthStatusLine({
  tone,
  action,
  className,
  children,
}: Readonly<{
  tone: StatusTone;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}>) {
  return (
    <div
      role={tone === 'failure' ? 'alert' : 'status'}
      data-slot="auth-status-line"
      data-tone={tone}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-[0.82rem] leading-snug text-foreground/90',
        LINE_TONE[tone] ?? 'border-border bg-white/[0.03]',
        className,
      )}
    >
      <StatusGlyph
        tone={tone}
        className={cn('mt-px', GLYPH_TONE[tone] ?? 'text-muted-foreground')}
      />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <p>{children}</p>
        {action}
      </div>
    </div>
  );
}
