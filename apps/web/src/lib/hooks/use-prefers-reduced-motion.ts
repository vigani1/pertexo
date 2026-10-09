import { useMediaQuery } from './use-media-query';

/** Whether the person asked the system to minimise motion. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
