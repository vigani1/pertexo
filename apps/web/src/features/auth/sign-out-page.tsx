import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button-variants';
import { ProgressButton } from '@/components/ui/progress-button';
import { CoreOrb } from '@/components/patterns/core-orb';
import { cn } from '@/lib/utils';
import { Wordmark } from './components/stage/wordmark';

/**
 * Signing out: the Core fades down while the session ends. If Pertexo can't
 * confirm it, the Core stays lit and people can try again.
 */
export function SignOutPage({
  pending,
  error,
  onRetry,
}: Readonly<{
  pending: boolean;
  error: string | undefined;
  onRetry: () => void;
}>) {
  const failed = error !== undefined;
  return (
    <div className="relative isolate min-h-dvh overflow-hidden bg-background">
      <div className="ambient fixed -z-10" aria-hidden="true" />
      <header className="absolute top-6 left-6 sm:top-9 sm:left-11">
        <Wordmark />
      </header>
      <main
        id="main"
        className="grid min-h-dvh place-items-center px-5 py-16 text-center"
      >
        <div className="flex max-w-sm flex-col items-center gap-5">
          <div
            aria-hidden="true"
            className={cn(
              'size-44',
              !failed &&
                'motion-safe:animate-[entry-core-fade_1.8s_var(--ease-unspool)_forwards]',
            )}
          >
            <CoreOrb state={failed ? 'failed' : 'idle'} className="size-full" />
          </div>
          {failed ? (
            <section
              aria-labelledby="sign-out-title"
              className="flex flex-col items-center gap-3"
            >
              <h1
                id="sign-out-title"
                className="font-display text-4xl leading-none"
              >
                Sign-out didn’t finish
              </h1>
              <p role="alert" className="text-sm text-muted-foreground">
                {error}
              </p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                <ProgressButton
                  type="button"
                  variant="primary"
                  className="min-w-32"
                  pending={pending}
                  pendingLabel="Signing out…"
                  onClick={onRetry}
                >
                  Try again
                </ProgressButton>
                <Link to="/" className={buttonVariants({ variant: 'ghost' })}>
                  Back to Pertexo
                </Link>
              </div>
            </section>
          ) : (
            <p
              role="status"
              className="font-mono text-xs text-subtle-foreground"
            >
              Signing out…
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
