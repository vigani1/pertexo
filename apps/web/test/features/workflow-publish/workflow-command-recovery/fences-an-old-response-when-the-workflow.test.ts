import { useWorkflowRunSubmission } from '@/features/workflow-publish/data/mutations/use-workflow-run-submission';

import { normalizeRunIntent } from '@/features/workflow-runs/model/commands/run-intent';

import type { ApiJsonRequest } from '@/lib/api/client';

import { act, renderHook, waitFor } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';

import {
  acceptedRun,
  apiClientFor,
  deferred,
  etagA,
  runId,
  savedState,
  StrictModeWrapper,
  workflowId,
  workspaceId,
} from './fixture';

describe('workflow run submission recovery', () => {
  it('fences an old response when the workflow identity changes', async () => {
    const response = deferred<unknown>();
    const onRunAccepted = vi.fn();
    const request = vi.fn(() => response.promise);
    const apiClient = apiClientFor(request);
    const hook = renderHook(
      ({ currentWorkflowId }) =>
        useWorkflowRunSubmission({
          apiClient,
          workspaceId,
          workflowId: currentWorkflowId,
          verifyIdentity: vi.fn().mockResolvedValue(undefined),
          isSessionPaused: () => false,
          ensureSaved: vi.fn().mockResolvedValue(undefined),
          onRunAccepted,
        }),
      { initialProps: { currentWorkflowId: workflowId } },
    );

    let submission!: Promise<boolean>;
    act(() => {
      submission = hook.result.current.startNew({ value: {} });
    });
    await waitFor(() => {
      expect(request).toHaveBeenCalledOnce();
    });
    hook.rerender({
      currentWorkflowId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    await act(async () => {
      response.resolve(acceptedRun());
      await submission;
    });

    expect(onRunAccepted).not.toHaveBeenCalled();
  });
});

describe('workflow run submission lifecycle', () => {
  it('does not dispatch a run after disposal during the save barrier', async () => {
    const saved = deferred<unknown>();
    const requests: ApiJsonRequest<unknown>[] = [];
    const ensureSaved = vi.fn(() => saved.promise);
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      return Promise.resolve(acceptedRun());
    });
    const hook = renderHook(() =>
      useWorkflowRunSubmission({
        apiClient,
        workspaceId,
        workflowId,
        verifyIdentity: vi.fn().mockResolvedValue(undefined),
        isSessionPaused: () => false,
        ensureSaved,
        onRunAccepted: vi.fn(),
      }),
    );

    let submission!: Promise<boolean>;
    act(() => {
      submission = hook.result.current.startNew({ value: {} });
    });
    await waitFor(() => {
      expect(ensureSaved).toHaveBeenCalledOnce();
    });
    hook.unmount();
    await act(async () => {
      saved.resolve(undefined);
      await submission;
    });

    expect(requests).toHaveLength(0);
  });
  it('submits and accepts a run normally under StrictMode', async () => {
    const requests: ApiJsonRequest<unknown>[] = [];
    const ensureSaved = vi.fn().mockResolvedValue(undefined);
    const onRunAccepted = vi.fn();
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      return Promise.resolve(acceptedRun());
    });
    const hook = renderHook(
      () =>
        useWorkflowRunSubmission({
          apiClient,
          workspaceId,
          workflowId,
          verifyIdentity: vi.fn().mockResolvedValue(undefined),
          isSessionPaused: () => false,
          ensureSaved,
          onRunAccepted,
        }),
      { wrapper: StrictModeWrapper },
    );

    await act(() => hook.result.current.startNew({ value: { a: 1 } }));

    expect(requests).toHaveLength(1);
    expect(ensureSaved).toHaveBeenCalledOnce();
    expect(onRunAccepted).toHaveBeenCalledOnce();
    expect(onRunAccepted).toHaveBeenCalledWith(runId);
    expect(hook.result.current.pending).toBe(false);
  });
  it('normalizes formatting and object-key order for run retry identity', () => {
    expect(normalizeRunIntent({ value: JSON.parse('{"a":1,"b":2}') })).toBe(
      normalizeRunIntent({ value: JSON.parse('{\n  "b": 2, "a": 1\n}') }),
    );
  });
});

describe('a run started just before the workflow changes', () => {
  it('stops waiting once the earlier workflow’s answer lands', async () => {
    let answer: ((response: unknown) => void) | undefined;
    const apiClient = apiClientFor(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const onRunAccepted = vi.fn();
    const hook = renderHook(
      ({ id }: { id: string }) =>
        useWorkflowRunSubmission({
          apiClient,
          workspaceId,
          workflowId: id,
          verifyIdentity: () => Promise.resolve(),
          isSessionPaused: () => false,
          ensureSaved: () => Promise.resolve(savedState(etagA, 2, 4)),
          onRunAccepted,
        }),
      { initialProps: { id: workflowId } },
    );

    let started: Promise<boolean> | undefined;
    act(() => {
      started = hook.result.current.startNew({ value: {} });
    });
    await waitFor(() => {
      expect(answer).toBeDefined();
    });
    expect(hook.result.current.pending).toBe(true);

    // Another workflow opens while the first one's run request is out.
    hook.rerender({ id: '99999999-9999-4999-8999-999999999999' });
    await act(async () => {
      answer?.(acceptedRun());
      await started;
    });
    // The late answer is ignored, and nothing is left waiting on it.
    expect(onRunAccepted).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toBe(false);
  });
});
