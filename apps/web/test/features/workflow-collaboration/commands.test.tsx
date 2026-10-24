import { getRequestUrl } from '../../support/request';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WorkflowCommentsPage } from '@/features/workflow-collaboration/public';
import { WorkflowDiscussion } from '@/features/workflow-collaboration/components/discussion';
import { collaborationKeys } from '@/features/workflow-collaboration/data/collaboration.queries';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import {
  userId,
  workspaceId,
  workflowId,
} from '../../support/fixtures/workflow-editor';
const threadId = '11111111-1111-4111-8111-111111111111',
  commentId = '22222222-2222-4222-8222-222222222222';
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type':
        status >= 400 ? 'application/problem+json' : 'application/json',
    },
  });
}
const scopeFor = (fetch: typeof globalThis.fetch) => ({
  apiClient: createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId,
  workspaceId,
  workflowId,
});
it('keeps typed text and an open member picker across background refreshes, and retries one uncertain command exactly', async () => {
  const writes: { body: unknown; key: string }[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((input, init) => {
      const path = getRequestUrl(input);
      if (init?.method === 'POST') {
        writes.push({
          body: JSON.parse(
            typeof init.body === 'string' ? init.body : 'null',
          ) as unknown,
          key: new Headers(init.headers).get('Idempotency-Key') ?? '',
        });
        if (writes.length === 1)
          return Promise.reject(new TypeError('Lost response'));
        return Promise.resolve(
          json({
            threadId,
            commentId,
            revision: 1,
            replayed: true,
            deleted: false,
            threadDeleted: false,
          }),
        );
      }
      if (path.includes('/people?'))
        return Promise.resolve(
          json({
            items: [{ userId, displayName: 'Ada', role: 'owner' }],
            nextCursor: null,
          }),
        );
      return Promise.resolve(json({ items: [], nextCursor: null }));
    });
  const scope = scopeFor(fetch),
    onNavigate = vi.fn();
  const { queryClient } = renderInRouter(
    <WorkflowCommentsPage
      scope={scope}
      steps={[]}
      search={{}}
      onNavigate={onNavigate}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'New discussion' }),
  );
  const text = screen.getByRole('textbox', { name: 'New discussion' });
  await user.type(text, 'Keep this thought');
  await user.click(screen.getByRole('button', { name: '@ Mention' }));
  const search = screen.getByRole('textbox', { name: 'Find a member' });
  await screen.findByRole('button', { name: 'Ada' });
  await queryClient.invalidateQueries({
    queryKey: collaborationKeys.scope(scope),
  });
  expect(screen.getByRole('textbox', { name: 'New discussion' })).toBe(text);
  expect(text).toHaveValue('Keep this thought');
  expect(screen.getByRole('textbox', { name: 'Find a member' })).toBe(search);
  await user.click(screen.getByRole('button', { name: 'Ada' }));
  await user.click(screen.getByRole('button', { name: 'Post comment' }));
  await screen.findByRole('button', { name: 'Retry the same action' });
  expect(text).toHaveValue('Keep this thought');
  expect(text).toBeDisabled();
  await user.click(
    screen.getByRole('button', { name: 'Retry the same action' }),
  );
  await waitFor(() => {
    expect(onNavigate).toHaveBeenCalledWith({ thread: threadId });
  });
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0]?.body).toEqual({
    body: 'Keep this thought',
    mentionUserIds: [userId],
    stepId: null,
  });
});
it('keeps an edited comment and its original revision when a newer reply or edit arrives', async () => {
  let revision = 1;
  const writes: unknown[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((input, init) => {
      if (init?.method === 'PUT') {
        writes.push(
          JSON.parse(
            typeof init.body === 'string' ? init.body : 'null',
          ) as unknown,
        );
        if (writes.length > 1)
          return Promise.resolve(
            json({
              threadId,
              commentId,
              revision: 3,
              replayed: false,
              deleted: false,
              threadDeleted: false,
            }),
          );
        return Promise.resolve(
          json(
            {
              type: 'https://pertexo.dev/problems/workflow.collaboration_conflict',
              title: 'Discussion or presence changed',
              status: 409,
              code: 'workflow.collaboration_conflict',
              detail: 'Review the latest comment before saving.',
              requestId: 'comment-conflict',
            },
            409,
          ),
        );
      }
      const thread = {
        id: threadId,
        workflowId,
        stepId: null,
        stepLabel: null,
        status: 'open',
        revision,
        createdBy: userId,
        createdAt: '2026-10-18T10:00:00.000Z',
        updatedAt: '2026-10-18T10:00:00.000Z',
        commentCount: 1,
        preview: 'Remote text',
      };
      return Promise.resolve(
        json({
          thread,
          comments: [
            {
              id: commentId,
              threadId,
              authorId: userId,
              authorName: 'Ada',
              body: 'Remote text ' + String(revision),
              revision,
              createdAt: thread.createdAt,
              editedAt: null,
              mentions: [],
            },
          ],
          nextCursor: null,
        }),
      );
    });
  const scope = scopeFor(fetch);
  const { queryClient } = renderInRouter(
    <WorkflowDiscussion
      scope={scope}
      threadId={threadId}
      anchor={undefined}
      steps={[]}
      onClose={vi.fn()}
      onLatest={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Edit comment' }));
  const edit = screen.getByRole('textbox', { name: 'Edit comment' });
  await user.clear(edit);
  await user.type(edit, 'My unfinished edit');
  revision = 2;
  await queryClient.invalidateQueries({
    queryKey: collaborationKeys.scope(scope),
  });
  expect(screen.getByRole('textbox', { name: 'Edit comment' })).toBe(edit);
  expect(edit).toHaveValue('My unfinished edit');
  await user.click(screen.getByRole('button', { name: 'Save comment' }));
  await waitFor(() => {
    expect(writes).toHaveLength(1);
  });
  expect(writes[0]).toMatchObject({
    body: 'My unfinished edit',
    expectedRevision: 1,
  });
  expect(edit).toHaveValue('My unfinished edit');
  await user.click(
    screen.getByRole('button', { name: 'Use latest revision for my edit' }),
  );
  await user.click(screen.getByRole('button', { name: 'Save comment' }));
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toMatchObject({
    body: 'My unfinished edit',
    expectedRevision: 2,
  });
});
it('mentions someone by typing @ and their name, as Slack does', async () => {
  const writes: unknown[] = [];
  const searched: string[] = [];
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((input, init) => {
      const path = getRequestUrl(input);
      if (init?.method === 'POST') {
        writes.push(
          JSON.parse(typeof init.body === 'string' ? init.body : 'null'),
        );
        return Promise.resolve(
          json({
            threadId,
            commentId,
            revision: 1,
            replayed: false,
            deleted: false,
            threadDeleted: false,
          }),
        );
      }
      if (path.includes('/people?')) {
        searched.push(new URL(path, 'http://x').searchParams.get('q') ?? '');
        return Promise.resolve(
          json({
            items: [{ userId, displayName: 'Ada Lovelace', role: 'owner' }],
            nextCursor: null,
          }),
        );
      }
      return Promise.resolve(json({ items: [], nextCursor: null }));
    });
  renderInRouter(
    <WorkflowCommentsPage
      scope={scopeFor(fetch)}
      steps={[]}
      search={{}}
      onNavigate={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'New discussion' }),
  );
  const text = screen.getByRole('textbox', { name: 'New discussion' });
  await user.type(text, 'Can you check this, @Ad');
  await user.click(await screen.findByRole('button', { name: 'Ada Lovelace' }));
  expect(text).toHaveValue('Can you check this, @Ada Lovelace ');
  expect(
    screen.getByRole('button', { name: 'Remove mention of Ada Lovelace' }),
  ).toBeVisible();
  expect(text).toHaveFocus();
  await user.keyboard('please');
  await user.click(screen.getByRole('button', { name: 'Post comment' }));
  await waitFor(() => {
    expect(writes).toEqual([
      {
        body: 'Can you check this, @Ada Lovelace please',
        mentionUserIds: [userId],
        stepId: null,
      },
    ]);
  });
});
