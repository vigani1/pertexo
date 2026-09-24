import type { InvitationAcceptanceJourney } from '@pertexo/contracts/schemas/identity-workspace';
import { useEffect, useEffectEvent, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { ProgressButton } from '@/features/auth/auth-stage.public';
import { InvitationHeading } from './invitation-heading';

type Completed = Extract<InvitationAcceptanceJourney, { state: 'completed' }>;

/** The thread ties off: it draws in, knots, and one ring of light pulses. */
function KnotMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 24"
      className="mx-auto mb-5 h-6 w-30 overflow-visible text-success"
    >
      <path
        d="M4 12h92"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="92"
        style={{ '--thread-length': '92' } as CSSProperties}
        className="motion-safe:animate-[entry-thread-draw_0.7s_var(--ease-unspool)_both]"
      />
      <circle
        cx="104"
        cy="12"
        r="5"
        fill="currentColor"
        className="origin-center [transform-box:fill-box] motion-safe:animate-knot motion-safe:[animation-delay:0.6s]"
      />
      <circle
        cx="104"
        cy="12"
        r="5"
        fill="none"
        stroke="currentColor"
        className="origin-center opacity-0 [transform-box:fill-box] motion-safe:animate-[entry-knot-ring_0.9s_ease-out_0.65s_both]"
      />
    </svg>
  );
}

/**
 * Joined: the knot ties and the workspace opens by itself after three
 * seconds, with a visible thread timer and a way to stay on this page.
 */
export function CompletedJourney({
  journey,
  pending,
  cleanupFailed,
  autoOpenAfterMs,
  onOpen,
}: Readonly<{
  journey: Completed;
  pending: boolean;
  cleanupFailed: boolean;
  autoOpenAfterMs: number;
  onOpen: () => void;
}>) {
  const [stayed, setStayed] = useState(false);
  const [opening, setOpening] = useState(false);
  const counting = !stayed && !opening && !pending && !cleanupFailed;
  const name = journey.workspace.name;

  function open() {
    setOpening(true);
    onOpen();
  }
  const openWhenDue = useEffectEvent(open);

  useEffect(() => {
    if (!counting) return;
    const timer = window.setTimeout(() => {
      openWhenDue();
    }, autoOpenAfterMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [autoOpenAfterMs, counting]);

  return (
    <>
      <KnotMark />
      <InvitationHeading workspaceName={name} role={journey.role}>
        {journey.membershipCreated
          ? `You joined ${name}`
          : `You’re already in ${name}`}
      </InvitationHeading>
      {counting ? (
        <div className="mt-6 flex flex-col items-center gap-2">
          <p role="status" className="text-[0.85rem] text-muted-foreground">
            Opening {name}…
          </p>
          <span
            aria-hidden="true"
            className="block h-0.5 w-40 overflow-hidden rounded-full bg-white/8"
          >
            <span
              style={{ animationDuration: `${String(autoOpenAfterMs)}ms` }}
              className="block h-full w-full rounded-full bg-success motion-safe:animate-[thread-timer_3s_linear_forwards]"
            />
          </span>
        </div>
      ) : null}
      <div className="mt-6 flex flex-col items-center gap-2">
        {cleanupFailed ? null : (
          <ProgressButton
            type="button"
            variant="primary"
            size="lg"
            className="w-full"
            pending={pending}
            pendingLabel="Opening…"
            onClick={open}
          >
            Open workspace
          </ProgressButton>
        )}
        {counting ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setStayed(true);
            }}
          >
            Stay here
          </Button>
        ) : null}
      </div>
    </>
  );
}
