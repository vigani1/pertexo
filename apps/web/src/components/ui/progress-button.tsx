import type { ComponentProps, ReactNode } from 'react';
import { formatCountdown } from '@/lib/format-time';
import { Button } from './button';
import { LoadingOrb } from './loading-orb';

type ProgressButtonProps = Omit<ComponentProps<typeof Button>, 'children'> &
  Readonly<{
    children: ReactNode;
    pending?: boolean;
    /** The swapped verb while the request is in flight, e.g. "Signing in…". */
    pendingLabel: string;
    /** Seconds until the action is allowed again (rate limit or cooldown). */
    waitSeconds?: number;
    /** Leads the countdown, e.g. "Try again in" or "Resend in". */
    waitLabel?: string;
  }>;

/**
 * The standard loading treatment for a command button: while pending it
 * shows the mini orb and swaps its verb; while it has to wait it counts down.
 * It is disabled in both cases, so a command can't be sent twice.
 */
export function ProgressButton({
  children,
  pending = false,
  pendingLabel,
  waitSeconds = 0,
  waitLabel = 'Try again in',
  disabled,
  ...props
}: ProgressButtonProps) {
  const waiting = waitSeconds > 0;
  return (
    <Button disabled={disabled === true || pending || waiting} {...props}>
      {pending ? <LoadingOrb data-icon="inline-start" /> : null}
      {pending ? (
        pendingLabel
      ) : waiting ? (
        <span>
          {waitLabel}{' '}
          <span className="font-mono tabular-nums">
            {formatCountdown(waitSeconds)}
          </span>
        </span>
      ) : (
        children
      )}
    </Button>
  );
}
