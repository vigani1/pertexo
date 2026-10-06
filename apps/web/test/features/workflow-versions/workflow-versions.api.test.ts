import type {
  WorkflowCallableTargetsResponse,
  WorkflowVersionResponse,
  WorkflowVersionsResponse,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  findWorkflowVersion,
  getAllWorkflowVersions,
  getWorkflowCallableTargetsPage,
  getWorkflowCallableTargetVersion,
} from '@/features/workflow-versions/public';
import { createApiClient } from '@/lib/api/client';
import { callableVersionSource } from '../../support/workflow-version-source-fixtures';
import { workflowCallPin } from '../../support/workflow-call-fixtures';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = callableVersionSource.workflowId;
const versionId = callableVersionSource.id;
const otherId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const target = {
  id: versionId,
  workflowId,
  versionNumber: 2,
  publishedAt: callableVersionSource.publishedAt,
  callableTarget: {
    pin: null,
    contract: null,
    eligibility: {
      status: 'unavailable',
      reason: 'native_authoring_unavailable',
    },
  },
} satisfies WorkflowCallableTargetsResponse['items'][number];
const projection = {
  projection: 'callableTarget',
  workspaceId,
  permissions: { canEditDraft: false, canUseInPublication: false },
  items: [target],
  nextCursor: null,
} satisfies WorkflowCallableTargetsResponse;

function fixture(body: unknown = projection, status = 200) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(() => Promise.resolve(Response.json(body, { status })));
  return {
    fetch,
    api: createApiClient({ fetch, readCsrfToken: () => undefined }),
  };
}

describe('public immutable-version typed wrappers', () => {
  it('keeps legacy explicit cursor pagination and exact source lookup behavior', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((path) => {
        if (typeof path !== 'string')
          throw new Error('Expected a relative API path.');
        const after = new URL(path, 'http://test').searchParams.get('after');
        return Promise.resolve(
          Response.json(
            after === null
              ? { items: [], nextCursor: 'source-next' }
              : { items: [callableVersionSource], nextCursor: null },
          ),
        );
      });
    const api = createApiClient({ fetch, readCsrfToken: () => undefined });
    await expect(
      getAllWorkflowVersions(api, workspaceId, workflowId),
    ).resolves.toEqual({ items: [callableVersionSource], nextCursor: null });
    await expect(
      findWorkflowVersion(api, workspaceId, workflowId, versionId),
    ).resolves.toEqual(callableVersionSource);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?limit=25&after=source-next`,
    );
  });

  it('returns server-verified descriptors and all four pin fields without inventing client permission', async () => {
    // Synthetic projection only, not evidence that a native route is available.
    const verified = {
      ...projection,
      items: [
        {
          ...target,
          callableTarget: {
            pin: workflowCallPin,
            contract: {
              input: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
              result: { type: 'object', properties: {}, required: [] },
            },
            eligibility: { status: 'eligible' },
          },
        },
      ],
    };
    const { api } = fixture(verified);
    const response = await getWorkflowCallableTargetVersion(
      api,
      workspaceId,
      workflowId,
      versionId,
    );
    expect(response).toEqual(verified);
    expect(response.permissions).toEqual({
      canEditDraft: false,
      canUseInPublication: false,
    });
    expect(response.items[0]?.callableTarget.pin).toEqual(workflowCallPin);
  });

  it('retains concrete legacy return types and source-only requests/decoding', async () => {
    expectTypeOf<ReturnType<typeof getAllWorkflowVersions>>().toEqualTypeOf<
      Promise<WorkflowVersionsResponse>
    >();
    expectTypeOf<ReturnType<typeof findWorkflowVersion>>().toEqualTypeOf<
      Promise<WorkflowVersionResponse>
    >();
    const { api, fetch } = fixture({
      items: [callableVersionSource],
      nextCursor: null,
    });
    const legacy: WorkflowVersionsResponse = await getAllWorkflowVersions(
      api,
      workspaceId,
      workflowId,
    );
    expect(legacy.items[0]?.graph).toEqual(callableVersionSource.graph);
    const source: WorkflowVersionResponse = await findWorkflowVersion(
      api,
      workspaceId,
      workflowId,
      versionId,
    );
    expect(source).toEqual(callableVersionSource);
    for (const [path] of fetch.mock.calls) {
      expect(path).toBe(
        `/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?limit=25`,
      );
    }
    const projected = fixture();
    await expect(
      getAllWorkflowVersions(projected.api, workspaceId, workflowId),
    ).rejects.toMatchObject({ kind: 'protocol' });
    await expect(
      findWorkflowVersion(projected.api, workspaceId, workflowId, versionId),
    ).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('requests one default projection page and only an explicit encoded cursor/limit', async () => {
    const { api, fetch } = fixture();
    expectTypeOf<
      ReturnType<typeof getWorkflowCallableTargetsPage>
    >().toEqualTypeOf<Promise<WorkflowCallableTargetsResponse>>();
    await expect(
      getWorkflowCallableTargetsPage(api, workspaceId, workflowId),
    ).resolves.toEqual(projection);
    await getWorkflowCallableTargetsPage(api, workspaceId, workflowId, {
      limit: 25,
      after: 'opaque+/=',
    });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?include=callableTarget&limit=1`,
    );
    const path = fetch.mock.calls[1]?.[0];
    if (typeof path !== 'string')
      throw new Error('Expected a relative API path.');
    const url = new URL(path, 'http://test');
    expect([...url.searchParams]).toEqual([
      ['include', 'callableTarget'],
      ['limit', '25'],
      ['after', 'opaque+/='],
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refreshes exactly the selected version on the same GET, without pagination or writes', async () => {
    const { api, fetch } = fixture();
    await expect(
      getWorkflowCallableTargetVersion(api, workspaceId, workflowId, versionId),
    ).resolves.toEqual(projection);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      `/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?include=callableTarget&versionId=${versionId}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([0, 26, 1.5, Number.NaN])(
    'rejects invalid page limit %s before HTTP',
    (limit) => {
      const { api, fetch } = fixture();
      expect(() =>
        getWorkflowCallableTargetsPage(api, workspaceId, workflowId, { limit }),
      ).toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid exact IDs and empty cursors before HTTP', () => {
    const { api, fetch } = fixture();
    expect(() =>
      getWorkflowCallableTargetVersion(api, workspaceId, workflowId, 'latest'),
    ).toThrow();
    expect(() =>
      getWorkflowCallableTargetsPage(api, workspaceId, workflowId, {
        after: '',
      }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { items: [callableVersionSource], nextCursor: null },
    { ...projection, graph: callableVersionSource.graph },
    { ...projection, workspaceId: otherId },
    { ...projection, items: [{ ...target, workflowId: otherId }] },
    { ...projection, items: [target, target] },
    {
      ...projection,
      items: [
        {
          ...target,
          callableTarget: {
            ...target.callableTarget,
            eligibility: { status: 'eligible' },
          },
        },
      ],
    },
  ])(
    'rejects wrong projection/schema/scope without returning usable data',
    async (body) => {
      const { api } = fixture(body);
      await expect(
        getWorkflowCallableTargetsPage(api, workspaceId, workflowId),
      ).rejects.toMatchObject({ kind: 'protocol' });
    },
  );

  it.each([
    { ...projection, items: [] },
    { ...projection, items: [{ ...target, id: otherId }] },
    { ...projection, nextCursor: 'more' },
    { ...projection, items: [target, { ...target, id: otherId }] },
  ])(
    'rejects incomplete/ambiguous/wrong exact-version responses',
    async (body) => {
      const { api } = fixture(body);
      await expect(
        getWorkflowCallableTargetVersion(
          api,
          workspaceId,
          workflowId,
          versionId,
        ),
      ).rejects.toMatchObject({ kind: 'protocol' });
    },
  );

  it('rejects an oversized page even when all entries fit the maximum response schema', async () => {
    const { api } = fixture({
      ...projection,
      items: [target, { ...target, id: otherId }],
    });
    await expect(
      getWorkflowCallableTargetsPage(api, workspaceId, workflowId),
    ).rejects.toMatchObject({ kind: 'protocol' });
  });

  it.each([401, 404, 503])(
    'preserves normalized HTTP %s failure instead of fake eligibility',
    async (status) => {
      const code =
        status === 401
          ? 'auth.unauthenticated'
          : status === 404
            ? 'resource.not_found'
            : 'workflow.callable_targets_unavailable';
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Unavailable',
            status,
            code,
            requestId: 'request-callable-targets',
          }),
          { status, headers: { 'content-type': 'application/problem+json' } },
        ),
      );
      const api = createApiClient({ fetch, readCsrfToken: () => undefined });
      await expect(
        getWorkflowCallableTargetVersion(
          api,
          workspaceId,
          workflowId,
          versionId,
        ),
      ).rejects.toMatchObject({ kind: 'problem', status, problem: { code } });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('passes cancellation to the exact read and does not start an already cancelled page', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          observed = init?.signal;
          observed?.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Cancelled', 'AbortError'));
            },
            { once: true },
          );
        }),
    );
    const api = createApiClient({ fetch, readCsrfToken: () => undefined });
    const result = getWorkflowCallableTargetVersion(
      api,
      workspaceId,
      workflowId,
      versionId,
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toMatchObject({ kind: 'canceled' });
    expect(observed?.aborted).toBe(true);
    await expect(
      getWorkflowCallableTargetsPage(api, workspaceId, workflowId, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: 'canceled' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
