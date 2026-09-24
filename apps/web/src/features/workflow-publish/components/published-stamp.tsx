import { Link } from '@tanstack/react-router';
import { PlayIcon, XIcon, ZapIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Status } from '@/components/ui/status';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

/** How long the canvas weave-in takes before the stamp presses in. */
export const WEAVE_IN_MS = 1_450;

/**
 * "v8 is live", pressed in once the canvas has woven the new version, with
 * the next useful steps. Reduced motion shows it at once, without motion.
 */
export function PublishedStamp({
  workspaceId,
  workflowId,
  versionNumber,
  hasTriggers,
  canRun,
  onRunNow,
  onDismiss,
}: Readonly<{
  workspaceId: string;
  workflowId: string;
  versionNumber: number;
  hasTriggers: boolean;
  canRun: boolean;
  onRunNow: () => void;
  onDismiss: () => void;
}>) {
  const reducedMotion = usePrefersReducedMotion();
  const [shown, setShown] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const timer = window.setTimeout(() => {
      setShown(true);
    }, WEAVE_IN_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [reducedMotion]);
  const visible = shown || reducedMotion;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-24 right-4 z-40 flex w-[min(20rem,calc(100vw-2rem))] flex-col items-end gap-2"
    >
      {visible ? (
        <>
          <p
            className={cn(
              'rounded-lg bg-primary px-3.5 py-2.5 font-heading text-[0.95rem] font-semibold text-primary-foreground shadow-primary-lift',
              !reducedMotion &&
                'motion-safe:animate-[editor-stamp_2.6s_var(--ease-unspool)_both]',
            )}
          >
            v{versionNumber} is live
          </p>
          <div className="lens pointer-events-auto flex w-full flex-col gap-3 rounded-lg p-3">
            <div className="flex items-center justify-between gap-2">
              <Status tone="success">Published</Status>
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
        </>
      ) : null}
    </div>
  );
}
