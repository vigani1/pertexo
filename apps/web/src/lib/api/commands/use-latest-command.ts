import { useMemo, useRef, useState } from 'react';
import { useLatestRequest } from '@/lib/hooks/use-latest-request';

export type LatestCommandOutcome<Output> =
  | Readonly<{ kind: 'done'; value: Output }>
  /** The current attempt failed; `failure` holds the cause. */
  | Readonly<{ kind: 'failed'; cause: unknown }>
  /** A newer attempt replaced it, or the page moved on: nothing to do. */
  | Readonly<{ kind: 'superseded' }>;

/**
 * A command whose latest attempt wins: a new attempt aborts the one before,
 * an unmount aborts what is left, and only the current attempt's answer or
 * failure is kept. A feature's data/ binds it to an endpoint and the cache
 * effects that follow; the screen reacts to `run`'s outcome.
 */
export function useLatestCommand<Input, Output>(
  send: (input: Input, signal: AbortSignal) => Promise<Output>,
  options: Readonly<{
    /** Refuse a new attempt while one is in flight (a command that mints a secret). */
    exclusive?: boolean;
    /** Stay pending after success, while the page navigates away. */
    holdOnSuccess?: boolean;
  }> = {},
) {
  const requests = useLatestRequest();
  const [failure, setFailure] = useState<unknown>();
  const inFlight = useRef(false);
  const { exclusive = false, holdOnSuccess = false } = options;
  return useMemo(
    () => ({
      pending: requests.pending,
      failure,
      clearFailure: () => {
        setFailure(undefined);
      },
      /** Drops the attempt in flight, if any. */
      abort: () => {
        requests.abort();
      },
      async run(input: Input): Promise<LatestCommandOutcome<Output>> {
        if (exclusive && inFlight.current) return { kind: 'superseded' };
        inFlight.current = true;
        const request = requests.begin();
        setFailure(undefined);
        let held = false;
        try {
          const value = await send(input, request.signal);
          if (!request.isCurrent()) return { kind: 'superseded' };
          held = holdOnSuccess;
          return { kind: 'done', value };
        } catch (cause) {
          if (!request.isCurrent()) return { kind: 'superseded' };
          setFailure(cause);
          return { kind: 'failed', cause };
        } finally {
          inFlight.current = false;
          if (!held) request.finish();
        }
      },
    }),
    [requests, failure, send, exclusive, holdOnSuccess],
  );
}
