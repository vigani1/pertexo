import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';
import {
  client,
  json,
  report,
  saved,
  userId,
  workspaceId,
  workflowId,
  etagA,
  wrapper,
} from './workflow-publication-snapshot/fixture';

afterEach(() => vi.useRealTimers());

it('dispatches validation after the lifecycle deadline even while wall time is behind', async () => {
  vi.useFakeTimers({ now: 100_000 });
  let current = 1_000_000;
  const now = () => current;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      json(
        {
          type: 'urn:pertexo:problem:workflow.validation_unavailable',
          title: 'Workflow validation unavailable',
          status: 503,
          code: 'workflow.validation_unavailable',
          requestId: 'clock-test',
        },
        { 'retry-after': '1' },
        503,
      ),
    )
    .mockResolvedValue(json(report, { etag: etagA }));
  const apiClient = client(fetch);
  const hook = renderHook(
    () =>
      useWorkflowPublication({
        apiClient,
        userId,
        workspaceId,
        workflowId,
        now,
        verifyIdentity: () => Promise.resolve(),
        ensureSaved: () => Promise.resolve(saved),
        isSavedDraftCurrent: () => true,
      }),
    { wrapper },
  );
  await act(async () => {
    await hook.result.current.validate();
  });
  expect(hook.result.current.validationBlockedUntil).toBe(1_005_000);
  current = 1_004_999;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
    await hook.result.current.validate();
  });
  expect(hook.result.current.validation).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
  current = 1_005_001;
  // Dispatch must see the lifecycle's current time, even before its next tick.
  await act(async () => {
    await hook.result.current.validate();
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(hook.result.current.validation?.report).toEqual(report);
});
