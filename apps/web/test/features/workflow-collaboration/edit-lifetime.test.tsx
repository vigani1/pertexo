import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { WorkflowCommentsPage } from '@/features/workflow-collaboration/public';
import { collaborationKeys } from '@/features/workflow-collaboration/data/collaboration.queries';
import { parseCollaborationSearch } from '@/features/workflow-collaboration/model/search';
import { createApiClient } from '@/lib/api/client';
import { NotificationsProvider } from '@/components/ui/toast';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  userId,
  workspaceId,
  workflowId,
} from '../../support/fixtures/workflow-editor';

const threadId = '11111111-1111-4111-8111-111111111111';
const commentId = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const rootPath = `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/comments`;

it('keeps the oldest edited row through a full reply-page rollover and saves its intended text and revision', async () => {
  const fixture = mountComments(true);
  const row = (await screen.findByText('Comment 1', { exact: true })).closest(
    'li',
  );
  if (row === null) throw new Error('Expected the oldest comment');
  await fixture.event.click(
    within(row).getByRole('button', { name: 'Edit comment' }),
  );
  const input = screen.getByRole('textbox', { name: 'Edit comment' });
  await fixture.event.clear(input);
  await fixture.event.type(input, 'My saved edit');
  fixture.addReply();
  await fixture.cache.invalidateQueries({
    queryKey: collaborationKeys.scope(fixture.scope),
  });
  await screen.findByText('Comment 21', { exact: true });
  expect(screen.getByRole('textbox', { name: 'Edit comment' })).toBe(input);
  expect(input).toHaveValue('My saved edit');
  await fixture.event.click(
    within(row).getByRole('button', { name: 'Save comment' }),
  );
  await waitFor(() => {
    expect(fixture.edits).toEqual([
      { body: 'My saved edit', mentionUserIds: [], expectedRevision: 1 },
    ]);
  });
});

it('asks before opening another discussion and keeps text and URL when staying', async () => {
  const { event, router } = mountComments(false);
  await event.click(
    await screen.findByRole('button', { name: 'New discussion' }),
  );
  const input = screen.getByRole('textbox', { name: 'New discussion' });
  await event.type(input, 'Keep this unfinished discussion');
  await event.click(
    await screen.findByRole('button', { name: /Open this discussion/u }),
  );
  const guard = await screen.findByRole('dialog', {
    name: 'Discard the unfinished discussion?',
  });
  await event.click(within(guard).getByRole('button', { name: 'Stay here' }));
  expect(router.state.location.href).toBe('/comments');
  expect(input).toHaveValue('Keep this unfinished discussion');
  await event.click(
    screen.getByRole('button', { name: /Open this discussion/u }),
  );
  await event.click(
    within(
      await screen.findByRole('dialog', {
        name: 'Discard the unfinished discussion?',
      }),
    ).getByRole('button', { name: 'Discard and leave' }),
  );
  await screen.findByRole('textbox', { name: 'Reply' });
  expect(router.state.location.href).toContain(`thread=${threadId}`);
  await event.click(
    screen.getByRole('button', { name: 'Back to discussions' }),
  );
  await event.click(
    await screen.findByRole('button', { name: 'New discussion' }),
  );
  expect(screen.getByRole('textbox', { name: 'New discussion' })).toHaveValue(
    '',
  );
});

it('blocks leaving pending and unconfirmed discussion commands, then lets a confirmed retry open its discussion', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attempts: { key: string | null; body: unknown }[] = [];
  mockServer.use(
    http.post(rootPath, async ({ request }) => {
      attempts.push({
        key: request.headers.get('idempotency-key'),
        body: await request.json(),
      });
      if (attempts.length === 1) {
        await held;
        return HttpResponse.error();
      }
      return HttpResponse.json({
        threadId,
        commentId: commentId(22),
        revision: 1,
        replayed: true,
        deleted: false,
        threadDeleted: false,
      });
    }),
  );
  const { event, router } = mountComments(false);
  try {
    await event.click(
      await screen.findByRole('button', { name: 'New discussion' }),
    );
    await event.type(
      screen.getByRole('textbox', { name: 'New discussion' }),
      'Keep this submitted discussion',
    );
    await event.click(screen.getByRole('button', { name: 'Post comment' }));
    await event.click(
      screen.getByRole('button', { name: /Open this discussion/u }),
    );
    let guard = await screen.findByRole('dialog', {
      name: 'Resolve the discussion change before leaving',
    });
    expect(
      within(guard).queryByRole('button', { name: 'Discard and leave' }),
    ).not.toBeInTheDocument();
    await event.click(within(guard).getByRole('button', { name: 'Stay here' }));
    release();
    await screen.findByRole('button', { name: 'Retry the same action' });
    await event.click(
      screen.getByRole('button', { name: /Open this discussion/u }),
    );
    guard = await screen.findByRole('dialog', {
      name: 'Resolve the discussion change before leaving',
    });
    expect(
      within(guard).queryByRole('button', { name: 'Discard and leave' }),
    ).not.toBeInTheDocument();
    await event.click(within(guard).getByRole('button', { name: 'Stay here' }));
    expect(router.state.location.href).toBe('/comments');
    await event.click(
      screen.getByRole('button', { name: 'Retry the same action' }),
    );
    await screen.findByRole('textbox', { name: 'Reply' });
    expect(router.state.location.href).toContain(`thread=${threadId}`);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]?.body).toEqual({
      body: 'Keep this submitted discussion',
      mentionUserIds: [],
      stepId: null,
    });
  } finally {
    release();
  }
});

function mountComments(discussion: boolean) {
  let count = 20;
  const edits: unknown[] = [];
  const thread = () => ({
    id: threadId,
    workflowId,
    stepId: null,
    stepLabel: null,
    status: 'open',
    revision: 1,
    createdBy: userId,
    createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:00:00.000Z',
    commentCount: count,
    preview: 'Open this discussion',
  });
  const comment = (index: number) => ({
    id: commentId(index),
    threadId,
    authorId: userId,
    authorName: 'Ada',
    body: `Comment ${String(index)}`,
    revision: 1,
    createdAt: new Date(
      Date.parse('2026-10-18T10:00:00Z') + index * 1000,
    ).toISOString(),
    editedAt: null,
    mentions: [],
  });
  mockServer.use(
    http.get(rootPath, () =>
      HttpResponse.json({ items: [thread()], nextCursor: null }),
    ),
    http.get(`${rootPath}/${threadId}`, ({ request }) => {
      const anchor = new URL(request.url).searchParams.get('anchor');
      return HttpResponse.json({
        thread: thread(),
        comments:
          anchor === commentId(1)
            ? [comment(1)]
            : Array.from({ length: 20 }, (_, index) => comment(count - index)),
        nextCursor: null,
      });
    }),
    http.put(
      `${rootPath}/${threadId}/comments/:commentId`,
      async ({ request }) => {
        edits.push(await request.json());
        return HttpResponse.json({
          threadId,
          commentId: commentId(1),
          revision: 2,
          replayed: false,
          deleted: false,
          threadDeleted: false,
        });
      },
    ),
  );
  const scope = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
  const cache = createQueryClient();
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => root,
    path: 'comments',
    validateSearch: parseCollaborationSearch,
    component: CommentsRoute,
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({
      initialEntries: [
        discussion ? `/comments?thread=${threadId}` : '/comments',
      ],
    }),
  });
  function CommentsRoute(): ReactElement {
    return (
      <WorkflowCommentsPage
        scope={scope}
        steps={[]}
        search={route.useSearch()}
        onNavigate={(search) => {
          const query = new URLSearchParams(
            Object.entries(search).flatMap(([key, value]) =>
              value === undefined ? [] : [[key, value]],
            ),
          );
          void router.navigate({ href: `/comments?${query.toString()}` });
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={cache}>
      <NotificationsProvider>
        <RouterProvider router={router} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return {
    event: userEvent.setup(),
    cache,
    scope,
    router,
    edits,
    addReply: () => {
      count = 21;
    },
  };
}
