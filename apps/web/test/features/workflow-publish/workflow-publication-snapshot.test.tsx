import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';

import { validateWorkflow } from '@/features/workflow-publish/data/workflow-publish.api';

import { workflowIssuesView } from '@/features/workflow-publish/model/validation/issues-state';

import { act, renderHook, waitFor } from '@testing-library/react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  client,
  deferred,
  etagA,
  etagB,
  graph,
  json,
  report,
  requestPath,
  saved,
  userId,
  workflowId,
  workspaceId,
  wrapper,
} from './workflow-publication-snapshot/fixture';

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
    // The retry repeats the uncertain publish exactly: no new key or body.
    const publishes = fetch.mock.calls.filter(([input]) =>
      requestPath(input).endsWith('/publish'),
    );
    expect(publishes).toHaveLength(2);
    const [first, retry] = publishes.map(([, init]) => ({
      etag: new Headers(init?.headers).get('if-match'),
      key: new Headers(init?.headers).get('idempotency-key'),
      body: init?.body,
    }));
    expect(retry).toEqual(first);
    expect(retry?.etag).toBe(etagA);
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
});
