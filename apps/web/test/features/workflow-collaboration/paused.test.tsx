import { screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { WorkflowCommentsPage } from '@/features/workflow-collaboration/public';
import { WorkflowDiscussion } from '@/features/workflow-collaboration/components/discussion';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import {
  userId,
  workspaceId,
  workflowId,
} from '../../support/fixtures/workflow-editor';

const threadId = '11111111-1111-4111-8111-111111111111';
const commentId = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-18T10:00:00.000Z';

function scopeReturning(body: unknown) {
  return {
    apiClient: createApiClient({
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    }),
    userId,
    workspaceId,
    workflowId,
  };
}

const discussion = {
  thread: {
    id: threadId,
    workflowId,
    stepId: null,
    stepLabel: null,
    status: 'open',
    revision: 1,
    createdBy: userId,
    createdAt: at,
    updatedAt: at,
    commentCount: 1,
    preview: 'Mine',
  },
  comments: [
    {
      id: commentId,
      threadId,
      authorId: userId,
      authorName: 'Ada',
      body: 'Mine',
      revision: 1,
      createdAt: at,
      editedAt: null,
      mentions: [],
    },
  ],
  nextCursor: null,
};

it('lists discussions but offers no new one while paused', async () => {
  renderInRouter(
    <WorkflowCommentsPage
      paused
      scope={scopeReturning({ items: [], nextCursor: null })}
      steps={[]}
      search={{ step: 'a-step' }}
      onNavigate={vi.fn()}
    />,
  );

  await screen.findByRole('heading', { name: 'Comments' });
  expect(
    screen.queryByRole('button', { name: 'New discussion' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('textbox', { name: 'New discussion' }),
  ).not.toBeInTheDocument();
});

it('shows a discussion but offers no way to change it while paused', async () => {
  renderInRouter(
    <WorkflowDiscussion
      paused
      scope={scopeReturning(discussion)}
      threadId={threadId}
      anchor={undefined}
      steps={[]}
      onClose={vi.fn()}
      onLatest={vi.fn()}
    />,
  );

  expect(await screen.findByText('Mine')).toBeVisible();
  for (const name of [
    'Edit comment',
    'Delete comment',
    'Resolve discussion',
    'Reply',
  ])
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
