import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';

import { workflowIssuesView } from '@/features/workflow-publish/model/validation/issues-state';

import { act, renderHook, waitFor } from '@testing-library/react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  client,
  deferred,
  etagA,
  graph,
  json,
  report,
  requestPath,
  saved,
  userId,
  workflowId,
  workspaceId,
  wrapper,
} from './fixture';

afterEach(() => vi.useRealTimers());

describe('publication checked-snapshot ownership', () => {
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
