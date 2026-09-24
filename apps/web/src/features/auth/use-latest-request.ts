import { useEffect, useMemo, useRef } from 'react';

export type LatestRequest = Readonly<{
  signal: AbortSignal;
  /** Still the page's latest request, and not aborted or unmounted. */
  isCurrent: () => boolean;
  /** Releases the slot; false when a newer request or unmount replaced it. */
  finish: () => boolean;
}>;

/**
 * One in-flight request per page. Starting another aborts the previous one,
 * and unmounting aborts whatever is left, so a late answer can never act on
 * a page (or identity) that has moved on.
 */
export function useLatestRequest() {
  const active = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );

  return useMemo(
    () => ({
      begin(): LatestRequest {
        active.current?.abort();
        const controller = new AbortController();
        active.current = controller;
        return {
          signal: controller.signal,
          isCurrent: () =>
            active.current === controller && !controller.signal.aborted,
          finish: () => {
            if (active.current !== controller) return false;
            active.current = undefined;
            return true;
          },
        };
      },
      abort() {
        active.current?.abort();
        active.current = undefined;
      },
    }),
    [],
  );
}
