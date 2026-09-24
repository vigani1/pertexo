import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/api-error';
import type { ApiClient, ApiJsonRequest } from '@/lib/api/client';
import { useWorkflowPublication } from '@/features/workflow-publish/mutations/use-workflow-publication';
import {
  normalizeRunIntent,
  useWorkflowRunSubmission,
} from '@/features/workflow-publish/mutations/use-workflow-run-submission';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const etagA = `"draft-v1.${'a'.repeat(43)}"`;
const etagB = `"draft-v1.${'b'.repeat(43)}"`;

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
          valid: true,
          issues: [],
          compatibility: compatibility(),
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
          schemaVersion: 1,
          graph: emptyGraph,
          checksum: `wf:v1:sha256:${'c'.repeat(64)}`,
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
      generation: 4,
      revision: 2,
    });
  });
});

describe('workflow run submission recovery', () => {
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
    expect(verifyIdentity).toHaveBeenCalledTimes(4);
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

const emptyGraph = { schemaVersion: 1, nodes: [], edges: [], settings: {} };

function savedState(etag: string, revision: number, generation: number) {
  return {
    etag,
    revision,
    generation,
    saveStatus: 'clean',
  } as const;
}

function compatibility() {
  return {
    compatible: true,
    fingerprint: `wf-compat:v1:sha256:${'a'.repeat(64)}`,
    issues: [],
  };
}

function apiClientFor(
  request: (input: ApiJsonRequest<unknown>) => Promise<unknown>,
): ApiClient {
  return {
    request,
    stream: vi.fn(),
  } as unknown as ApiClient;
}

function acceptedRun() {
  return {
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
    replayed: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function StrictModeWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(StrictMode, undefined, children);
}

function QueryWrapper({ children }: Readonly<{ children: ReactNode }>) {
  return createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    children,
  );
}
