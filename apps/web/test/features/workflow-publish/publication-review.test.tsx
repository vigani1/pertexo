import userEvent from '@testing-library/user-event';
import { renderInRouter } from '../../support/render-in-router';
import { PublicationReviewPage } from '@/features/workflow-publish/reviews.public';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { useWorkflowPublication } from '@/features/workflow-publish/data/mutations/use-workflow-publication';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const reviewId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const etag = `"draft.${'a'.repeat(43)}"`;
const json = (value: unknown, headers?: HeadersInit) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(value), { headers: responseHeaders });
};
const report = {
  valid: true,
  currentPublication: null,
  issues: [],
  compatibility: {
    compatible: true,
    fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
    issues: [],
  },
};
function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
it('retries the original review note, saved revision, ETag and key after an ambiguous response', async () => {
  const commands: { etag: string | null; key: string | null; body: unknown }[] =
    [];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/validate'))
      return Promise.resolve(json(report, { ETag: etag }));
    if (!url.endsWith('/publication-review'))
      throw new Error(`Unexpected endpoint ${url}`);
    const headers = new Headers(init?.headers);
    if (typeof init?.body !== 'string')
      throw new Error('Expected a JSON request body');
    commands.push({
      etag: headers.get('If-Match'),
      key: headers.get('Idempotency-Key'),
      body: JSON.parse(init.body) as unknown,
    });
    if (commands.length === 1)
      return Promise.reject(
        new TypeError('Connection closed before acknowledgement'),
      );
    return Promise.resolve(
      json({
        id: reviewId,
        workflowId,
        workflowName: 'Release',
        requestedBy: userId,
        requesterName: 'Builder',
        draftRevision: 4,
        note: 'Original review note',
        status: 'pending',
        createdAt: '2026-10-18T10:00:00.000Z',
        expiresAt: '2026-10-25T10:00:00.000Z',
        decidedBy: null,
        deciderName: null,
        decidedAt: null,
        comment: null,
        publishedVersionId: null,
        versionNumber: null,
        canDecide: false,
      }),
    );
  });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  const ensureSaved = vi.fn(() =>
    Promise.resolve({ etag, generation: 3, revision: 4 }),
  );
  const { result } = renderHook(
    () =>
      useWorkflowPublication({
        apiClient,
        userId,
        workspaceId,
        workflowId,
        verifyIdentity: () => Promise.resolve(),
        ensureSaved,
        isSavedDraftCurrent: () => true,
      }),
    { wrapper },
  );
  await act(async () => {
    expect(
      await result.current.publish({
        kind: 'review',
        note: 'Original review note',
      }),
    ).toEqual({ kind: 'failed' });
  });
  expect(result.current.publishRecoveryPending).toBe(true);
  expect(result.current.recoveryCommand).toBe('review');
  await act(async () => {
    expect(
      await result.current.publish({
        kind: 'review',
        note: 'Changed after failure',
      }),
    ).toMatchObject({ kind: 'review_requested', request: { id: reviewId } });
  });
  expect(ensureSaved).toHaveBeenCalledTimes(1);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toEqual(commands[1]);
  expect(commands[0]).toMatchObject({
    etag,
    body: { note: 'Original review note' },
  });
  expect(commands[0]?.key).toBeTruthy();
  expect(result.current.publishRecoveryPending).toBe(false);
});

it('shows a stale publication decision’s recovery detail and refreshes the review', async () => {
  let decided = false;
  const request = {
    id: reviewId,
    workflowId,
    workflowName: 'Release',
    requestedBy: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    requesterName: 'Builder',
    draftRevision: 1,
    note: 'Release note',
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    decidedBy: null,
    deciderName: null,
    decidedAt: null,
    comment: null,
    publishedVersionId: null,
    versionNumber: null,
    canDecide: true,
  };
  const detail =
    'The draft changed after this request. Review the latest draft and request approval again.';
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const path = input instanceof Request ? input.url : input.toString();
    if (path.endsWith('/decision')) {
      decided = true;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'urn:pertexo:problem:workflow.publication_review_conflict',
            title: 'Review changed',
            status: 409,
            code: 'workflow.publication_review_conflict',
            detail,
            requestId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          }),
          {
            status: 409,
            headers: { 'Content-Type': 'application/problem+json' },
          },
        ),
      );
    }
    return Promise.resolve(
      json({
        request: {
          ...request,
          status: decided ? 'stale' : 'pending',
          canDecide: !decided,
        },
        graph: null,
        liveGraph: null,
      }),
    );
  });
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  renderInRouter(
    <PublicationReviewPage
      scope={{ apiClient, userId, workspaceId }}
      reviewId={reviewId}
      capabilities={[]}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Approve and publish' }),
  );
  expect(await screen.findByText(detail)).toBeVisible();
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Approve and publish' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole('link', { name: 'Open workflow editor' }),
  ).toHaveAttribute('href', `/w/${workspaceId}/workflows/${workflowId}`);
});
