import type { ComponentProps } from 'react';
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
        'font-display text-[1.875rem] leading-none tracking-[-0.02em] [--display-optical-size:30] [--display-width:82%]',
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
