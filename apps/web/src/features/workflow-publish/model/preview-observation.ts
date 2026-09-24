import type {
  NodeValidationResponse,
  PreviewRunSummary,
} from '@pertexo/contracts/schemas/node-testing';
import type { StatusTone } from '@/components/ui/status';
import type { ApiClient } from '@/lib/api/client';
import { getWorkflowNodePreview } from '../node-test.api';

export const previewTerminalStatuses: ReadonlySet<PreviewRunSummary['status']> =
  new Set(['succeeded', 'failed', 'canceled', 'timed_out', 'outcome_unknown']);

const PREVIEW_POLL_INTERVAL_MS = 1_000;
const PREVIEW_POLL_LIMIT = 60;

/** Polls an accepted test until it finishes, about a minute at most. */
export async function observePreview(
  apiClient: ApiClient,
  workspaceId: string,
  previewRunId: string,
  signal: AbortSignal,
): Promise<PreviewRunSummary> {
  for (let attempt = 0; attempt < PREVIEW_POLL_LIMIT; attempt += 1) {
    await delay(PREVIEW_POLL_INTERVAL_MS, signal);
    const response = await getWorkflowNodePreview(
      apiClient,
      workspaceId,
      previewRunId,
      signal,
    );
    if (previewTerminalStatuses.has(response.preview.status))
      return response.preview;
  }
  throw new Error(
    'The test is still running. Check its status again in a moment.',
  );
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const previewTones: Readonly<Record<PreviewRunSummary['status'], StatusTone>> =
  {
    queued: 'queued',
    running: 'live',
    succeeded: 'success',
    failed: 'failure',
    canceled: 'canceled',
    timed_out: 'timeout',
    outcome_unknown: 'attention',
  };

const previewWords: Readonly<Record<PreviewRunSummary['status'], string>> = {
  queued: 'Waiting to start',
  running: 'Running',
  succeeded: 'Test passed',
  failed: 'Test failed',
  canceled: 'Test canceled',
  timed_out: 'Test timed out',
  outcome_unknown: 'Outcome unknown',
};

export function describePreviewStatus(status: PreviewRunSummary['status']) {
  return { tone: previewTones[status], label: previewWords[status] } as const;
}

/**
 * What a real test does outside Pertexo, in plain words. The step's own
 * sentence wins; otherwise the server's disclosure decides.
 */
export function sideEffectSentence(
  stepSentence: string | undefined,
  disclosure: NodeValidationResponse['disclosure'] | undefined,
): string {
  if (disclosure !== undefined && !disclosure.mayCauseExternalSideEffect)
    return disclosure.mayContactProvider
      ? 'This test contacts an outside service but doesn’t change anything there.'
      : 'This test doesn’t change anything outside Pertexo.';
  if (stepSentence !== undefined) return stepSentence;
  return disclosure === undefined
    ? 'A test runs this step for real, so anything it does outside Pertexo really happens.'
    : 'This test can change things outside Pertexo.';
}
