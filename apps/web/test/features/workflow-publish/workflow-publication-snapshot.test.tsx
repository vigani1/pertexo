import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { workflowIssuesView } from '@/features/workflow-publish/model/issues-state';
import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';
import { validateWorkflow } from '@/features/workflow-publish/data/workflow-publish.api';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const etagA = `"draft.${'a'.repeat(43)}"`;
const etagB = `"draft.${'b'.repeat(43)}"`;
const graph = { schemaVersion: 1 as const, nodes: [], edges: [], settings: {} };
const report = {
  valid: true,
  issues: [],
  compatibility: {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  },
};
const saved = { etag: etagA, generation: 4, revision: 2 };

function json(body: unknown, headers: HeadersInit = {}, status = 200) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set(
    'content-type',
    status === 200 ? 'application/json' : 'application/problem+json',
  );
  return new Response(JSON.stringify(body), {
    status,
    headers: responseHeaders,
  });
}

function client(fetch: typeof globalThis.fetch) {
  return createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
}

function requestPath(input: Parameters<typeof globalThis.fetch>[0]) {
  return input instanceof Request ? input.url : input.toString();
}

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        {children}
      </QueryClientProvider>
    </StrictMode>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe('checked validation transport', () => {
  it('decodes the report with its server-snapshot ETag using the real transport', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(json(report, { etag: etagB }));
    await expect(
      validateWorkflow(client(fetch), workspaceId, workflowId),
    ).resolves.toEqual({ report, etag: etagB });
    expect(
      new Headers(fetch.mock.calls[0]?.[1]?.headers).get('x-csrf-token'),
    ).toBeTruthy();
  });

  it.each([undefined, 'not-an-etag', `W/${etagA}`])(
    'rejects absent or malformed metadata (%s) as a protocol failure',
    async (etag) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(json(report, etag === undefined ? {} : { etag }));
      await expect(
        validateWorkflow(client(fetch), workspaceId, workflowId),
      ).rejects.toMatchObject({ kind: 'protocol' });
    },
  );
});

describe('publication checked-snapshot ownership', () => {
  it('keeps the exact uncertain publish recoverable during a later validation cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(report, { etag: etagA }))
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(
        json(
          {
            type: 'urn:pertexo:problem:workflow.validation_unavailable',
            title: 'Workflow validation unavailable',
            status: 503,
            code: 'workflow.validation_unavailable',
            requestId: 'retry-unavailable',
          },
          { 'retry-after': '1' },
          503,
        ),
      )
      .mockResolvedValueOnce(
        json({
          version: {
            id: userId,
            workflowId,
            versionNumber: 1,
            schemaVersion: 1,
            graph,
            checksum: `wf:sha256:${'c'.repeat(64)}`,
            publishedAt: '2026-09-15T10:00:00.000Z',
          },
          reused: true,
        }),
      );
    const apiClient = client(fetch);
    const verifyIdentity = vi.fn().mockResolvedValue(undefined);
    const ensureSaved = vi.fn().mockResolvedValue(saved);
    let current = true;
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity,
          ensureSaved,
          isSavedDraftCurrent: () => current,
        }),
      { wrapper },
    );
    await act(() => hook.result.current.publish());
    expect(hook.result.current.publishRecoveryPending).toBe(true);
    await act(() => hook.result.current.validate());
    expect(hook.result.current.validationBlockedUntil).toBe(105_000);
    current = false;
    await act(() => hook.result.current.publish());
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(new Headers(fetch.mock.calls[3]?.[1]?.headers).get('if-match')).toBe(
      etagA,
    );
    expect(
      new Headers(fetch.mock.calls[3]?.[1]?.headers).get('idempotency-key'),
    ).toBe(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get('idempotency-key'),
    );
    expect(fetch.mock.calls[3]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body);
    expect(ensureSaved).toHaveBeenCalledTimes(2);
    expect(verifyIdentity).toHaveBeenCalledTimes(2);
    expect(hook.result.current.publicationReceipt?.revision).toBe(2);
  });

  it.each(['identity', 'save'])(
    'honors a new cooldown after publication resumes from pending %s verification',
    async (prerequisite) => {
      vi.useFakeTimers();
      vi.setSystemTime(100_000);
      const waiting = deferred<undefined>();
      const reached = deferred<undefined>();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          json(
            {
              type: 'urn:pertexo:problem:workflow.validation_unavailable',
              title: 'Workflow validation unavailable',
              status: 503,
              code: 'workflow.validation_unavailable',
              requestId: 'concurrent-unavailable',
            },
            { 'retry-after': '1' },
            503,
          ),
        )
        .mockImplementation((input) =>
          Promise.resolve(
            requestPath(input).endsWith('/validate')
              ? json(report, { etag: etagA })
              : json({
                  version: {
                    id: userId,
                    workflowId,
                    versionNumber: 1,
                    schemaVersion: 1,
                    graph,
                    checksum: `wf:sha256:${'c'.repeat(64)}`,
                    publishedAt: '2026-09-15T10:00:00.000Z',
                  },
                  reused: false,
                }),
          ),
        );
      const apiClient = client(fetch);
      let identityCalls = 0;
      let saveCalls = 0;
      const hook = renderHook(
        () =>
          useWorkflowPublication({
            apiClient,
            userId,
            workspaceId,
            workflowId,
            verifyIdentity: () => {
              if (prerequisite === 'identity' && ++identityCalls === 1) {
                reached.resolve(undefined);
                return waiting.promise;
              }
              return Promise.resolve();
            },
            ensureSaved: () => {
              if (prerequisite === 'save' && ++saveCalls === 1) {
                reached.resolve(undefined);
                return waiting.promise.then(() => saved);
              }
              return Promise.resolve(saved);
            },
            isSavedDraftCurrent: () => true,
          }),
        { wrapper },
      );
      let publishing!: ReturnType<typeof hook.result.current.publish>;
      act(() => {
        publishing = hook.result.current.publish();
      });
      await act(async () => {
        await reached.promise;
      });
      await act(() => hook.result.current.validate());
      expect(fetch).toHaveBeenCalledOnce();
      expect(hook.result.current.validationPending).toBe(false);
      expect(hook.result.current.validationBlockedUntil).toBe(105_000);
      await act(async () => {
        waiting.resolve(undefined);
        await publishing;
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(hook.result.current.publicationReceipt).toBeUndefined();
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      expect(fetch).toHaveBeenCalledOnce();
      await act(() => hook.result.current.publish());
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(hook.result.current.publicationReceipt?.revision).toBe(2);
    },
  );

  it('shares an in-flight unavailable check without immediately checking again', async () => {
    const response = deferred<Response>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => response.promise);
    const apiClient = client(fetch);
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: () => true,
        }),
      { wrapper },
    );
    let checking!: Promise<void>;
    let publishing!: ReturnType<typeof hook.result.current.publish>;
    act(() => {
      checking = hook.result.current.validate();
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    act(() => {
      publishing = hook.result.current.publish();
    });
    await act(async () => {
      response.resolve(
        json(
          {
            type: 'urn:pertexo:problem:workflow.validation_unavailable',
            title: 'Workflow validation unavailable',
            status: 503,
            code: 'workflow.validation_unavailable',
            requestId: 'shared-unavailable',
          },
          { 'retry-after': '1' },
          503,
        ),
      );
      await Promise.all([checking, publishing]);
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(hook.result.current.publishError).toMatch(
      /temporarily unavailable/u,
    );
    expect(hook.result.current.publishRecoveryPending).toBe(false);
  });

  it('reuses only a matching saved snapshot and sends its original precondition', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((input) =>
      Promise.resolve(
        requestPath(input).endsWith('/validate')
          ? json(report, { etag: etagA })
          : json({
              version: {
                id: userId,
                workflowId,
                versionNumber: 1,
                schemaVersion: 1,
                graph,
                checksum: `wf:sha256:${'c'.repeat(64)}`,
                publishedAt: '2026-09-15T10:00:00.000Z',
              },
              reused: false,
            }),
      ),
    );
    const apiClient = client(fetch);
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: () => true,
        }),
      { wrapper },
    );
    await act(() => hook.result.current.validate());
    await act(() => hook.result.current.publish());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('if-match')).toBe(
      etagA,
    );
    expect(hook.result.current.publicationReceipt?.revision).toBe(2);
  });

  it('keeps another-tab snapshot readable but stale, and never dispatches publication', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => Promise.resolve(json(report, { etag: etagB })));
    const apiClient = client(fetch);
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: () => true,
        }),
      { wrapper },
    );
    expect(await act(() => hook.result.current.publish())).toEqual({
      kind: 'blocked',
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(hook.result.current.validation?.etag).toBe(etagB);
    expect(workflowIssuesView(hook.result.current, graph, saved)).toMatchObject(
      { stale: true, groups: [] },
    );
    expect(hook.result.current.publishError).toMatch(/different draft/u);
  });

  it('blocks publication when local edits occur while checking the saved graph', async () => {
    const response = deferred<Response>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => response.promise);
    const apiClient = client(fetch);
    let current = saved;
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: (checked) =>
            checked.generation === current.generation,
        }),
      { wrapper },
    );
    let pending!: ReturnType<typeof hook.result.current.publish>;
    act(() => {
      pending = hook.result.current.publish();
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    current = { ...saved, generation: 5 };
    await act(async () => {
      response.resolve(json(report, { etag: etagA }));
      await pending;
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(hook.result.current.publicationReceipt).toBeUndefined();
    expect(workflowIssuesView(hook.result.current, graph, current).stale).toBe(
      true,
    );
  });

  it('ignores a delayed validation after workflow scope changes or unmounts', async () => {
    const response = deferred<Response>();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(() => response.promise);
    const apiClient = client(fetch);
    const hook = renderHook(
      ({ id }) =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId: id,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: () => true,
        }),
      { wrapper, initialProps: { id: workflowId } },
    );
    let pending!: Promise<void>;
    act(() => {
      pending = hook.result.current.validate();
    });
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledOnce();
    });
    hook.rerender({ id: userId });
    await act(async () => {
      response.resolve(json(report, { etag: etagA }));
      await pending;
    });
    expect(hook.result.current.validation).toBeUndefined();
    hook.unmount();
  });

  it.each(['identity', 'unmount'])(
    'ignores a delayed publication after %s disposal',
    async (disposal) => {
      const accepted = deferred<Response>();
      const onPublicationAccepted = vi.fn();
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((input) =>
          requestPath(input).endsWith('/validate')
            ? Promise.resolve(json(report, { etag: etagA }))
            : accepted.promise,
        );
      const apiClient = client(fetch);
      const hook = renderHook(
        ({ currentUserId }) =>
          useWorkflowPublication({
            apiClient,
            userId: currentUserId,
            workspaceId,
            workflowId,
            verifyIdentity: () => Promise.resolve(),
            ensureSaved: () => Promise.resolve(saved),
            isSavedDraftCurrent: () => true,
            onPublicationAccepted,
          }),
        { wrapper, initialProps: { currentUserId: userId } },
      );
      let pending!: ReturnType<typeof hook.result.current.publish>;
      act(() => {
        pending = hook.result.current.publish();
      });
      await waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(2);
      });
      if (disposal === 'identity') hook.rerender({ currentUserId: workflowId });
      else hook.unmount();
      await act(async () => {
        accepted.resolve(
          json({
            version: {
              id: userId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph,
              checksum: `wf:sha256:${'c'.repeat(64)}`,
              publishedAt: '2026-09-15T10:00:00.000Z',
            },
            reused: false,
          }),
        );
        await pending;
      });
      expect(onPublicationAccepted).not.toHaveBeenCalled();
      expect(hook.result.current.publicationReceipt).toBeUndefined();
    },
  );

  it('enforces the unavailable cooldown for manual checks and new publication without automatic replay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(
          {
            type: 'urn:pertexo:problem:workflow.validation_unavailable',
            title: 'Workflow validation unavailable',
            status: 503,
            code: 'workflow.validation_unavailable',
            requestId: 'request-unavailable',
          },
          { 'retry-after': '1' },
          503,
        ),
      )
      .mockImplementation(() => Promise.resolve(json(report, { etag: etagA })));
    const apiClient = client(fetch);
    const hook = renderHook(
      () =>
        useWorkflowPublication({
          apiClient,
          userId,
          workspaceId,
          workflowId,
          verifyIdentity: () => Promise.resolve(),
          ensureSaved: () => Promise.resolve(saved),
          isSavedDraftCurrent: () => true,
        }),
      { wrapper },
    );
    await act(() => hook.result.current.validate());
    expect(hook.result.current.validationBlockedUntil).toBe(105_000);
    await act(() => hook.result.current.validate());
    await act(() => hook.result.current.publish());
    expect(fetch).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    await act(() => hook.result.current.validate());
    expect(fetch).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(fetch).toHaveBeenCalledOnce();
    await act(() => hook.result.current.validate());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.validationError).toBeUndefined();
  });
});
