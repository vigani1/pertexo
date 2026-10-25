import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';

import { useWorkflowRunSubmission } from '@/features/workflow-publish/data/mutations/use-workflow-run-submission';

import type { ApiJsonRequest } from '@/lib/api/client';

import { ApiError } from '@/lib/api/error';

import { act, renderHook, waitFor } from '@testing-library/react';

import { describe, expect, it, vi } from 'vitest';

import {
  acceptedRun,
  apiClientFor,
  compatibility,
  deferred,
  emptyGraph,
  etagA,
  etagB,
  QueryWrapper,
  runId,
  savedState,
  userId,
  versionId,
  workflowId,
  workspaceId,
} from './workflow-command-recovery/fixture';

describe('workflow publication recovery', () => {
  it('recovers an uncertain publish with its original precondition and key', async () => {
    const savedA = savedState(etagA, 2, 4);
    const savedB = savedState(etagB, 3, 5);
    const saveBarrier = vi
      .fn()
      .mockResolvedValueOnce(savedA)
      .mockResolvedValueOnce(savedA)
      .mockResolvedValue(savedB);
    const requests: ApiJsonRequest<unknown>[] = [];
    let publishCalls = 0;
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      if (request.path.endsWith('/validate'))
        return Promise.resolve({
          report: {
            valid: true,
            currentPublication: null,
            issues: [],
            compatibility: compatibility(),
          },
          etag: etagA,
        });
      publishCalls += 1;
      if (publishCalls === 1)
        return Promise.reject(
          new ApiError({ kind: 'network', message: 'connection lost' }),
        );
      return Promise.resolve({
        version: {
          id: versionId,
          workflowId,
          versionNumber: 1,
          graph: emptyGraph,
          checksum: `wf:sha256:${'c'.repeat(64)}`,
          publishedAt: '2026-09-15T10:00:00.000Z',
        },
        reused: true,
      });
    });
    const verifyIdentity = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity,
          ensureSaved: saveBarrier,
          isSavedDraftCurrent: () => true,
        }),
      { wrapper: QueryWrapper },
    );

    await act(() => hook.result.current.validate());
    await act(() => hook.result.current.publish());
    expect(hook.result.current.publishRecoveryPending).toBe(true);
    verifyIdentity.mockRejectedValueOnce(new Error('identity changed'));
    await act(() => hook.result.current.publish());
    expect(
      requests.filter((request) => request.path.endsWith('/publish')),
    ).toHaveLength(1);
    expect(hook.result.current.publishRecoveryPending).toBe(true);
    verifyIdentity.mockRejectedValueOnce(new Error('verification unavailable'));
    await act(() => hook.result.current.publish());
    expect(
      requests.filter((request) => request.path.endsWith('/publish')),
    ).toHaveLength(1);
    expect(hook.result.current.publishRecoveryPending).toBe(true);
    await act(() => hook.result.current.publish());

    const publishes = requests.filter((request) =>
      request.path.endsWith('/publish'),
    );
    expect(publishes).toHaveLength(2);
    expect(publishes[1]?.headers).toEqual(publishes[0]?.headers);
    expect(publishes[0]?.headers?.['If-Match']).toBe(etagA);
    expect(saveBarrier).toHaveBeenCalledTimes(2);
    expect(verifyIdentity).toHaveBeenCalledTimes(4);
    expect(hook.result.current.publicationReceipt).toEqual({
      versionId,
      versionNumber: 1,
      reused: true,
      etag: etagA,
      generation: 4,
      revision: 2,
    });
  });
});

describe('workflow run submission recovery', () => {
  it('freezes value, deadline, version and key and rejects replacement while uncertain', async () => {
    const requests: ApiJsonRequest<unknown>[] = [];
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      return Promise.reject(
        new ApiError({ kind: 'network', message: 'lost response' }),
      );
    });
    const hook = renderHook(() =>
      useWorkflowRunSubmission({
        apiClient,
        workspaceId,
        workflowId,
        verifyIdentity: vi.fn().mockResolvedValue(undefined),
        isSessionPaused: () => false,
        ensureSaved: vi.fn().mockResolvedValue(undefined),
        onRunAccepted: vi.fn(),
      }),
    );
    const input = { proof: 'original' };
    await act(() =>
      hook.result.current.startNew({
        value: input,
        deadlineAt: '2026-10-02T12:00:00.000Z',
        expectedPublishedVersionId: versionId,
      }),
    );
    input.proof = 'changed after dispatch';
    await act(() =>
      hook.result.current.startNew({
        value: {},
        expectedPublishedVersionId: workflowId,
      }),
    );
    expect(requests).toHaveLength(1);
    await act(() => hook.result.current.retry());
    expect(requests[1]?.body).toEqual(requests[0]?.body);
    expect(requests[1]?.headers).toEqual(requests[0]?.headers);
    expect(requests[1]?.body).toEqual({
      input: { proof: 'original' },
      deadlineAt: '2026-10-02T12:00:00.000Z',
      expectedPublishedVersionId: versionId,
    });
  });
  it('stops exact retries at the original 24-hour window without silently permitting replacement', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const dispatch = vi.fn(() =>
        Promise.reject(
          new ApiError({ kind: 'timeout', message: 'lost response' }),
        ),
      );
      const apiClient = apiClientFor(dispatch);
      const hook = renderHook(() =>
        useWorkflowRunSubmission({
          apiClient,
          workspaceId,
          workflowId,
          verifyIdentity: vi.fn().mockResolvedValue(undefined),
          isSessionPaused: () => false,
          ensureSaved: vi.fn().mockResolvedValue(undefined),
          onRunAccepted: vi.fn(),
        }),
      );
      await act(() => hook.result.current.startNew({ value: {} }));
      clock.mockReturnValue(1_000 + 86_400_000);
      await act(() => hook.result.current.retry());
      await act(() =>
        hook.result.current.startNew({ value: { replacement: true } }),
      );
      expect(dispatch).toHaveBeenCalledOnce();
      expect(hook.result.current.error).toContain(
        '24-hour recovery window has ended',
      );
      expect(hook.result.current.retryAvailable).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
  it('keeps the accepted ID when fresh opening authority cannot be confirmed and never resubmits it', async () => {
    const dispatch = vi.fn(() => Promise.resolve(acceptedRun()));
    const apiClient = apiClientFor(dispatch);
    const verifyIdentity = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('identity temporarily unavailable'))
      .mockResolvedValue(undefined);
    const onRunAccepted = vi.fn();
    const hook = renderHook(() =>
      useWorkflowRunSubmission({
        apiClient,
        workspaceId,
        workflowId,
        verifyIdentity,
        isSessionPaused: () => false,
        ensureSaved: vi.fn().mockResolvedValue(undefined),
        onRunAccepted,
      }),
    );
    await act(() => hook.result.current.startNew({ value: {} }));
    expect(hook.result.current.acceptedRunId).toBe(runId);
    expect(onRunAccepted).not.toHaveBeenCalled();
    await act(() => hook.result.current.retry());
    await act(() => hook.result.current.openAcceptedRun());
    expect(dispatch).toHaveBeenCalledOnce();
    expect(onRunAccepted).toHaveBeenCalledWith(runId);
  });
  it('retries the exact accepted run intent without another save barrier', async () => {
    const requests: ApiJsonRequest<unknown>[] = [];
    let calls = 0;
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      calls += 1;
      if (calls === 1)
        return Promise.reject(
          new ApiError({ kind: 'timeout', message: 'timed out' }),
        );
      return Promise.resolve({
        run: {
          id: runId,
          workspaceId,
          workflowId,
          workflowVersionId: versionId,
          status: 'queued',
          triggerType: 'manual',
          createdAt: '2026-09-15T10:00:00.000Z',
          updatedAt: '2026-09-15T10:00:00.000Z',
          startedAt: null,
          completedAt: null,
          deadlineAt: null,
          cancelRequestedAt: null,
        },
        replayed: true,
      });
    });
    const saveBarrier = vi.fn().mockResolvedValue(undefined);
    const verifyIdentity = vi.fn().mockResolvedValue(undefined);
    const onRunAccepted = vi.fn();
    const hook = renderHook(() =>
      useWorkflowRunSubmission({
        apiClient,
        workspaceId,
        workflowId,
        verifyIdentity,
        isSessionPaused: () => false,
        ensureSaved: saveBarrier,
        onRunAccepted,
      }),
    );

    await act(() => hook.result.current.startNew({ value: { b: 2, a: 1 } }));
    expect(hook.result.current.retryAvailable).toBe(true);
    verifyIdentity.mockRejectedValueOnce(new Error('identity changed'));
    await act(() => hook.result.current.retry());
    expect(requests).toHaveLength(1);
    expect(hook.result.current.retryAvailable).toBe(true);
    verifyIdentity.mockRejectedValueOnce(new Error('verification unavailable'));
    await act(() => hook.result.current.retry());
    expect(requests).toHaveLength(1);
    expect(hook.result.current.retryAvailable).toBe(true);
    await act(() => hook.result.current.retry());

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers).toEqual(requests[0]?.headers);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
    expect(saveBarrier).toHaveBeenCalledOnce();
    expect(verifyIdentity).toHaveBeenCalledTimes(5);
    expect(onRunAccepted).toHaveBeenCalledWith(runId);
  });
  it('ignores an accepted run after the submission owner unmounts', async () => {
    const response = deferred<unknown>();
    const requests: ApiJsonRequest<unknown>[] = [];
    const onRunAccepted = vi.fn();
    const apiClient = apiClientFor((request) => {
      requests.push(request);
      return response.promise;
    });
    const hook = renderHook(() =>
      useWorkflowRunSubmission({
        apiClient,
        workspaceId,
        workflowId,
        verifyIdentity: vi.fn().mockResolvedValue(undefined),
        isSessionPaused: () => false,
        ensureSaved: vi.fn().mockResolvedValue(undefined),
        onRunAccepted,
      }),
    );

    let submission!: Promise<boolean>;
    act(() => {
      submission = hook.result.current.startNew({ value: {} });
    });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    hook.unmount();
    await act(async () => {
      response.resolve(acceptedRun());
      await submission;
    });

    expect(onRunAccepted).not.toHaveBeenCalled();
  });
});
