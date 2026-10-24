import { Link } from '@tanstack/react-router';
import { PlayIcon, XIcon, ZapIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status } from '@/components/ui/status';
import { usePrefersReducedMotion } from '@/lib/hooks/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

/** How long the canvas weave-in takes before the stamp presses in. */
const WEAVE_IN_MS = 1_450;

/**
 * One notice, "v8 is live", pressed in once the canvas has woven the new
 * version, with the next useful steps. Reduced motion shows it at once, without motion.
 */
export function PublishedStamp({
  versionNumber,
  reused,
  liveAgain,
  hasTriggers,
  canRun,
  onRunNow,
  onDismiss,
  scope,
}: Readonly<{
  versionNumber: number;
  reused: boolean;
  liveAgain: boolean;
  hasTriggers: boolean;
  canRun: boolean;
  onRunNow: () => void;
  onDismiss: () => void;
  scope: Readonly<{ workspaceId: string; workflowId: string }>;
}>) {
  const { workspaceId, workflowId } = scope;

  const reducedMotion = usePrefersReducedMotion();
  const [shown, setShown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion || reused) return;
    const timer = window.setTimeout(() => {
      setShown(true);
    }, WEAVE_IN_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reducedMotion, reused]);
  const visible = shown || reducedMotion || reused;
  return (
    // The editor owns the feedback layer below its header and notices.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute top-0 right-0 z-40 flex w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2 lg:right-[calc(var(--editor-right-inset,1rem)-0.75rem)]"
    >
      {visible ? (
        <div
          className={cn(
            'lens pointer-events-auto flex w-full flex-col gap-3 rounded-lg p-3',
            !reducedMotion &&
              !reused &&
              'motion-safe:animate-[editor-stamp_2.6s_var(--ease-unspool)_both]',
          )}
        >
          <div className="flex items-center justify-between gap-2">
            <Status tone="success">
              <span className="font-heading text-[0.95rem] font-semibold text-foreground">
                v{versionNumber} is{' '}
                {publicationStateLabel({ reused, liveAgain })}
              </span>
            </Status>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={onDismiss}
            >
              <XIcon />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {hasTriggers ? (
              <Link
                to="/w/$workspaceId/workflows/$workflowId/triggers"
                params={{ workspaceId, workflowId }}
                className={buttonVariants({ size: 'sm', variant: 'outline' })}
              >
                <ZapIcon data-icon="inline-start" />
                Open Triggers
              </Link>
            ) : null}
            {canRun ? (
              <Button type="button" size="sm" onClick={onRunNow}>
                <PlayIcon data-icon="inline-start" />
                Run now
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function publicationStateLabel(
  input: Readonly<{ reused: boolean; liveAgain: boolean }>,
) {
  if (!input.reused) return 'live';
  return input.liveAgain ? 'live again' : 'still live';
}
