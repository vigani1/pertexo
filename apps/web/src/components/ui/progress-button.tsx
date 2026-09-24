import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { LoadingOrb } from '@/components/ui/loading-orb';
import { formatCountdown } from '@/lib/format-time';

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
 * A button that keeps its place while work happens: the mini orb and a
 * swapped verb while pending, a live countdown while it has to wait.
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
      {pending ? <LoadingOrb /> : null}
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
