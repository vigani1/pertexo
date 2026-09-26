import { useState, type ReactNode } from 'react';
import { MailIcon } from 'lucide-react';
import {
  isRateLimited,
  rateLimitSeconds,
  resendFailure,
} from '../../model/auth-failure';
import { ProgressButton } from '@/components/ui/progress-button';
import type { Countdown } from '@/lib/use-countdown';
import { useLatestRequest } from '../../use-latest-request';
import {
  AuthLens,
  AuthLensDescription,
  AuthLensTitle,
} from '../stage/auth-lens';
import { Notice } from '@/components/ui/notice';

/** How long people wait before asking for the same email again. */
export const RESEND_COOLDOWN_SECONDS = 60;

type Feedback = Readonly<{ tone: 'success' | 'destructive'; text: string }>;

/**
 * "Check your inbox": the address, a resend with a cooldown, and a way back.
 * The owner starts `cooldown` when it sends the first email.
 */
export function InboxLens({
  title,
  children,
  cooldown,
  resend,
  resendLabel = 'Resend link',
  sentFeedback = 'Sent. It can take a minute to arrive.',
  footer,
}: Readonly<{
  title: string;
  children: ReactNode;
  cooldown: Countdown;
  resend: (signal: AbortSignal) => Promise<unknown>;
  resendLabel?: string;
  sentFeedback?: string;
  footer?: ReactNode;
}>) {
  const requests = useLatestRequest();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>();

  async function send() {
    if (pending || cooldown.remainingSeconds > 0) return;
    const request = requests.begin();
    setPending(true);
    setFeedback(undefined);
    try {
      await resend(request.signal);
      if (!request.isCurrent()) return;
      cooldown.startSeconds(RESEND_COOLDOWN_SECONDS);
      setFeedback({ tone: 'success', text: sentFeedback });
    } catch (error) {
      if (!request.isCurrent()) return;
      if (isRateLimited(error))
        cooldown.startSeconds(
          rateLimitSeconds(error) ?? RESEND_COOLDOWN_SECONDS,
        );
      setFeedback({ tone: 'destructive', text: resendFailure(error) });
    } finally {
      if (request.finish()) setPending(false);
    }
  }

  return (
    <AuthLens pending={pending} aria-labelledby="inbox-title">
      <span
        aria-hidden="true"
        className="mb-5 grid size-10 place-items-center rounded-full border border-primary/25 bg-primary/8 text-accent-foreground"
      >
        <MailIcon className="size-4.5" />
      </span>
      <AuthLensTitle id="inbox-title">{title}</AuthLensTitle>
      <AuthLensDescription>{children}</AuthLensDescription>
      {feedback === undefined ? null : (
        <Notice tone={feedback.tone} className="mt-5">
          {feedback.text}
        </Notice>
      )}
      <ProgressButton
        type="button"
        variant="default"
        className="mt-6 w-full"
        pending={pending}
        pendingLabel="Sending…"
        waitSeconds={cooldown.remainingSeconds}
        waitLabel="Resend in"
        onClick={() => void send()}
      >
        {resendLabel}
      </ProgressButton>
      {footer}
    </AuthLens>
  );
}
