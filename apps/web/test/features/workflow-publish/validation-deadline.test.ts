import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useWorkflowDraftValidation } from '@/features/workflow-publish/data/mutations/use-workflow-draft-validation';
import { ApiError } from '@/lib/api/error';
import {
  client,
  saved,
  workspaceId,
  workflowId,
} from './workflow-publication-snapshot/fixture';

it('enforces the retry floor just before its deadline and releases just after it', () => {
  let now = 100_000;
  const hook = renderHook(() =>
    useWorkflowDraftValidation({
      apiClient: client(globalThis.fetch),
      workspaceId,
      workflowId,
      owner: { current: Symbol('owner') },
      ensureSaved: () => Promise.resolve(saved),
      isSavedDraftCurrent: () => true,
      now: () => now,
    }),
  );
  act(() => {
    hook.result.current.recordValidationCooldown(
      new ApiError({
        kind: 'problem',
        message: 'Wait',
        status: 429,
        retryAfterMs: 1_000,
      }),
    );
  });
  expect(hook.result.current.validationBlockedUntil).toBe(105_000);
  now = 104_999;
  expect(() => {
    hook.result.current.assertValidationAvailable();
  }).toThrow(/temporarily unavailable/u);
  now = 105_001;
  expect(() => {
    hook.result.current.assertValidationAvailable();
  }).not.toThrow();
});
