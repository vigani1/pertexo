import { screen, waitFor } from '@testing-library/react';

import { describe, expect, it } from 'vitest';

import { renderApp } from '../../../support/render-app';

import { importId, inboxApi, thread, workspaceId } from './fixture';

describe('new failure notice', () => {
  it('stays quiet on the inbox page, whose list shows the failure', async () => {
    const state = { threads: [] as ReturnType<typeof thread>[], revision: '7' };
    const { stream, unreadLists } = inboxApi(state);
    const { queryClient } = renderApp(`/w/${workspaceId}/inbox`);

    await screen.findByRole('heading', { name: 'Inbox' });
    state.threads = [thread(importId, { revision: '8' })];
    state.revision = '8';
    stream.changed('8');

    expect(
      await screen.findByRole('link', { name: 'Nightly import, unread' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(unreadLists.count).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
