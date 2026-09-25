import type { ScheduleStepConfig } from '@pertexo/contracts/schemas/schedules';
import { use, useEffect, useEffectEvent, useState } from 'react';
import { isApiError } from '@/lib/api/api-error';
import { describeReadError } from '@/lib/api/api-error-copy';
import { canonicalizeJson } from '@/lib/canonical-json';
import { previewScheduleRuns } from './schedule-preview.api';
import { SchedulePreviewScope } from './schedule-preview-scope';

/** Typing pauses this long before the rule is sent for a preview. */
const PREVIEW_DELAY_MS = 500;
const MAX_TIMER_MS = 2_147_483_647;

export type SchedulePreview =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'loading' }>
  | Readonly<{ status: 'ready'; times: readonly string[] }>
  | Readonly<{ status: 'failed'; message: string; retry: () => void }>;

type Settled = Readonly<{ key: string; attempt: number }> &
  (Readonly<{ times: readonly string[] }> | Readonly<{ error: unknown }>);

function failureMessage(error: unknown): string {
  if (isApiError(error) && error.status === 400)
    return 'Pertexo can’t schedule this rule. Check the cron fields and the timezone.';
  return describeReadError(error, 'Next runs');
}

/**
 * The next run times of an unsaved Schedule rule, from the server's own
 * scheduler: debounced while the rule changes, asked again once its first
 * run time passes, and never guessed in the browser (ADR 048).
 */
export function useSchedulePreview(
  config: ScheduleStepConfig | undefined,
): SchedulePreview {
  const scope = use(SchedulePreviewScope);
  const key =
    config === undefined || scope === null
      ? undefined
      : canonicalizeJson(config);
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<Settled>();

  const request = useEffectEvent((signal: AbortSignal) =>
    scope === null || config === undefined
      ? Promise.reject(new Error('A schedule preview needs a rule'))
      : previewScheduleRuns(
          scope.apiClient,
          scope.workspaceId,
          scope.workflowId,
          { config, signal },
        ),
  );

  useEffect(() => {
    if (key === undefined) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      request(controller.signal).then(
        (response) => {
          setSettled({
            key,
            attempt,
            times: response.items.map(({ scheduledAt }) => scheduledAt),
          });
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setSettled({ key, attempt, error });
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);

  const current = settled?.key === key ? settled : undefined;
  const firstAt =
    current !== undefined && 'times' in current ? current.times[0] : undefined;
  useEffect(() => {
    if (firstAt === undefined) return;
    // Once the first run time passes, ask again rather than show the past.
    const wait = Date.parse(firstAt) - Date.now() + 1_000;
    const timer = window.setTimeout(
      () => {
        setAttempt((value) => value + 1);
      },
      Math.min(Math.max(wait, 1_000), MAX_TIMER_MS),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [firstAt]);

  if (key === undefined) return { status: 'unavailable' };
  if (current === undefined) return { status: 'loading' };
  if ('times' in current) return { status: 'ready', times: current.times };
  if (current.attempt !== attempt) return { status: 'loading' };
  return {
    status: 'failed',
    message: failureMessage(current.error),
    retry: () => {
      setAttempt((value) => value + 1);
    },
  };
}
