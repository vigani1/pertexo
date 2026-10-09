import { useEffect, useMemo, useRef, useState } from 'react';

export type LatestRequest = Readonly<{
  signal: AbortSignal;
  /** Still the page's latest request, and not aborted or unmounted. */
  isCurrent: () => boolean;
  /**
   * Releases the slot and ends `pending`; false (and nothing changes) when
   * a newer request or unmount already replaced it, since the newer request
   * ends `pending` itself.
   */
  finish: () => boolean;
}>;

/**
 * One in-flight request per page, and whether it's pending. Starting another
 * aborts the previous one, and unmounting aborts whatever is left, so a late
 * answer can never act on a page (or identity) that has moved on. Only the
 * current request ends `pending`: a superseded one finishing late can't
 * switch off the spinner of the request that replaced it.
 */
export function useLatestRequest() {
  const active = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);

  useEffect(
    () => () => {
      active.current?.abort();
      active.current = undefined;
    },
    [],
  );

  const slot = useMemo(
    () => ({
      begin(): LatestRequest {
        active.current?.abort();
        const controller = new AbortController();
        active.current = controller;
        setPending(true);
        return {
          signal: controller.signal,
          isCurrent: () =>
            active.current === controller && !controller.signal.aborted,
          finish: () => {
            if (active.current !== controller) return false;
            active.current = undefined;
            setPending(false);
            return true;
          },
        };
      },
      /** Drops the request in flight, if any; nothing is pending after. */
      abort() {
        active.current?.abort();
        active.current = undefined;
        setPending(false);
      },
    }),
    [],
  );

  return useMemo(() => ({ ...slot, pending }), [slot, pending]);
}
