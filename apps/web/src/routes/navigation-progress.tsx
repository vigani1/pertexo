import { useRouterState } from '@tanstack/react-router';
import { SkeletonThread } from '@/components/ui/skeleton';

/**
 * A slim thread along the top of the window while a page change waits, for
 * example on the session and workspace check that every workspace page runs
 * again. It reads the router's pending state and stays invisible for the
 * first 150 ms like every skeleton, so a quick change never flashes it. A
 * cold start has its own boot page instead. With reduced motion the thread
 * holds still.
 */
export function NavigationProgress() {
  const waiting = useRouterState({
    select: (state) =>
      state.status === 'pending' && state.resolvedLocation !== undefined,
  });
  if (!waiting) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading the page"
      className="pointer-events-none fixed inset-x-0 top-0 z-70 skeleton-wait"
    >
      <SkeletonThread className="h-[3px] rounded-none bg-white/8 after:shadow-[0_0_8px_var(--primary)] motion-reduce:bg-accent-foreground/45" />
    </div>
  );
}
