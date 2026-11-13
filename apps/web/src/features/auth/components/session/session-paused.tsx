import { useEffect, useRef } from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { SignInAction } from '@/components/patterns/states/sign-in-action';
import {
  SystemState,
  SystemStateActions,
  SystemStateArt,
  SystemStateDescription,
  SystemStateTitle,
} from '@/components/patterns/states/system';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ProgressButton } from '@/components/ui/progress-button';
import type { SessionPauseReason } from '../../model/session/pause';

const COPY: Record<
  SessionPauseReason,
  Readonly<{ title: string; description: string }>
> = {
  expired: {
    title: 'Your session ended',
    description:
      'Sign in again in a new tab. This page waits here with your unsaved changes, and carries on when you come back.',
  },
  checking: {
    title: 'Checking who’s signed in',
    description:
      'Another tab changed who is signed in. This page waits until it knows it’s still you, so nothing is saved under the wrong account.',
  },
  unreachable: {
    title: 'We couldn’t check your session',
    description:
      'Pertexo didn’t answer, so this page is waiting. Your unsaved changes are still here. Check your connection, then continue.',
  },
};

/**
 * The page behind this is still mounted, hidden, with everything typed into
 * it. Continuing checks the account and shows the page again as it was.
 */
export function SessionPaused({
  reason,
  returnTo,
  checking,
  stillSignedOut,
  onContinue,
  onLeave,
}: Readonly<{
  reason: SessionPauseReason;
  /** The paused page, for the sign-in tab to open after signing in. */
  returnTo: string;
  checking: boolean;
  /** The last Continue found nobody signed in. */
  stillSignedOut: boolean;
  onContinue: () => void;
  onLeave: () => void;
}>) {
  const heading = useRef<HTMLHeadingElement>(null);
  // The page that had focus is hidden; start reading from the explanation.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const copy = COPY[reason];
  return (
    <div
      className="grid min-h-svh place-items-center px-4"
      aria-busy={checking}
    >
      <SystemState>
        <SystemStateArt>
          <KeyRoundIcon aria-hidden="true" className="size-10 text-warning" />
        </SystemStateArt>
        <SystemStateTitle ref={heading} tabIndex={-1} className="outline-none">
          {copy.title}
        </SystemStateTitle>
        <SystemStateDescription>{copy.description}</SystemStateDescription>
        {/* Reserved, so the actions don't move when the line appears. */}
        <p role="status" className="min-h-5 text-sm text-warning">
          {stillSignedOut && !checking
            ? 'You’re still signed out here. Finish signing in, then continue.'
            : null}
        </p>
        <SystemStateActions>
          {reason === 'expired' ? (
            <SignInAction
              className={buttonVariants({ variant: 'primary' })}
              returnTo={returnTo}
            />
          ) : null}
          <ProgressButton
            type="button"
            variant={reason === 'expired' ? 'outline' : 'primary'}
            pending={checking}
            pendingLabel="Checking…"
            onClick={onContinue}
          >
            {reason === 'unreachable' ? 'Try again' : 'Continue'}
          </ProgressButton>
          <Button type="button" variant="ghost" onClick={onLeave}>
            Discard changes and sign in here
          </Button>
        </SystemStateActions>
      </SystemState>
    </div>
  );
}
