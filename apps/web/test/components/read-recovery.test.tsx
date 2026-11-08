import userEvent from '@testing-library/user-event';
import { LoadMore } from '@/components/patterns/lists/load-more';
import { act, render, screen, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useInfiniteQuery,
} from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationsProvider } from '@/components/ui/toast';
import {
  QueryView,
  FailedReadState,
} from '@/components/patterns/states/query-view';
import { createApiClient } from '@/lib/api/client';
afterEach(() => vi.restoreAllMocks());
function setup(status: number, designed = false) {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Request failed',
          status,
          code: status === 429 ? 'request.rate_limited' : 'internal.unexpected',
          requestId: 'full-safe-support-reference',
        }),
        {
          status,
          headers: {
            'content-type': 'application/problem+json',
            'retry-after': '2',
          },
        },
      ),
    ),
  );
  const client = createApiClient({ fetch, readCsrfToken: () => undefined });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  function Reader() {
    const query = useQuery({
      queryKey: ['notes'],
      queryFn: () =>
        client.request({
          path: '/v1/notes',
          response: { kind: 'json', decode: (value) => value },
        }),
    });
    if (designed)
      return query.isError ? (
        <FailedReadState
          title="Notes couldn’t be loaded"
          error={query.error}
          retrying={query.isFetching}
          retry={() => {
            void query.refetch();
          }}
        />
      ) : null;
    return (
      <QueryView query={query} resource="Notes">
        {(value) => (
          <output aria-label="Server result">{JSON.stringify(value)}</output>
        )}
      </QueryView>
    );
  }
  render(
    <QueryClientProvider client={cache}>
      <NotificationsProvider>
        <Reader />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return { fetch, cache };
}
it('disables read retries until Retry-After has counted down', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { cache } = setup(429);
  const retry = await screen.findByRole('button', {
    name: /Try again in|Retry/,
  });
  expect(retry).toBeDisabled();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  now += 2_000;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /Try again in|Retry/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByText('Too many requests. You can try again now.'),
  ).toBeVisible();
  cache.clear();
});
it('retries a failed first read and displays the recovered server result', async () => {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { fetch, cache } = setup(500);
  expect(await screen.findByText('full-safe-support-reference')).toBeVisible();
  fetch.mockResolvedValueOnce(
    new Response(JSON.stringify({ recovered: true }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  now += 2_100;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const retry = await screen.findByRole('button', { name: 'Retry' });
  await userEvent.setup().click(retry);
  expect(await screen.findByLabelText('Server result')).toHaveTextContent(
    '{"recovered":true}',
  );
  expect(
    screen.queryByText('full-safe-support-reference'),
  ).not.toBeInTheDocument();
  cache.clear();
});
it('retains the full safe support reference on a failed first read', async () => {
  const { cache } = setup(500);
  expect(await screen.findByText('full-safe-support-reference')).toBeVisible();
  expect(screen.getByRole('button', { name: /Copy error ID/ })).toBeVisible();
  await screen.findByRole('button', { name: /Try again in/ });
  expect(
    screen.getByText('Notes couldn’t be loaded. Try again.'),
  ).toBeVisible();
  cache.clear();
});

it('keeps earlier rows and local edits while a next-page refusal owns cooldown and support details', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ items: ['Saved note'], nextCursor: 'next' }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Rate limited',
          status: 429,
          code: 'request.rate_limited',
          requestId: 'next-page-support-reference',
        }),
        {
          status: 429,
          headers: {
            'content-type': 'application/problem+json',
            'retry-after': '60',
          },
        },
      ),
    );
  const client = createApiClient({ fetch, readCsrfToken: () => undefined });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Reader() {
    const query = useInfiniteQuery({
      queryKey: ['paged-notes'],
      initialPageParam: null as string | null,
      queryFn: ({ pageParam }) =>
        client.request({
          path: `/v1/notes?after=${pageParam ?? ''}`,
          response: {
            kind: 'json',
            decode: (value) =>
              value as { items: string[]; nextCursor: string | null },
          },
        }),
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    return (
      <>
        <QueryView query={query} resource="Notes">
          {(data) => (
            <input
              aria-label="Draft reply"
              defaultValue={data.pages[0]?.items[0]}
            />
          )}
        </QueryView>
        <LoadMore
          subject="notes"
          hasNextPage={query.hasNextPage}
          loading={query.isFetchingNextPage}
          failed={query.isFetchNextPageError}
          error={query.error}
          onLoadMore={() => {
            void query.fetchNextPage();
          }}
        />
      </>
    );
  }
  render(
    <QueryClientProvider client={cache}>
      <NotificationsProvider>
        <Reader />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  const field = await screen.findByRole('textbox', { name: 'Draft reply' });
  await userEvent.setup().type(field, ' and local edits');
  await userEvent
    .setup()
    .click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('next-page-support-reference')).toBeVisible();
  expect(screen.getByRole('button', { name: /Try again in/ })).toBeDisabled();
  expect(field).toHaveValue('Saved note and local edits');
  expect(fetch).toHaveBeenCalledTimes(2);
  cache.clear();
});

it('uses one changing cooldown sentence in a designed first-read state', async () => {
  const { cache } = setup(429, true);
  await screen.findByRole('button', { name: /Try again in/ });
  expect(
    screen.getAllByText('Too many requests. Try again in 2 s.'),
  ).toHaveLength(1);
  cache.clear();
});
