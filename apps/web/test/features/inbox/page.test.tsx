import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import {
  api,
  billingId,
  failedStep,
  importId,
  inboxApi,
  runId,
  spineInbox,
  thread,
  user,
  workspace,
  workspaceId,
} from './page/fixture';

describe('workspace inbox', () => {
  it('lists failing workflows with how often and where they failed', async () => {
    inboxApi({
      threads: [
        thread(importId, {
          kind: 'timed_out',
          failureDays: [],
          occurrenceCount: 3,
          latestFailedStep: {
            nodeId: 'fetch',
            label: 'Fetch orders',
            definitionKey: 'core.http',
            safeErrorCode: null,
          },
        }),
        thread(billingId, { unread: false }),
      ],
      revision: '7',
    });
    renderApp(`/w/${workspaceId}/inbox`);

    const list = await screen.findByRole('list', { name: 'Notices' });
    const [first, second, ...rest] = within(list).getAllByRole('listitem');
    if (first === undefined || second === undefined)
      throw new Error('Expected two notices');
    expect(rest).toEqual([]);
    expect(
      within(first).getByRole('link', { name: 'Nightly import, unread' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
    expect(within(first).getByText('Timed out')).toBeVisible();
    expect(first).toHaveTextContent('Failed 3 times since');
    expect(first).toHaveTextContent('at Fetch orders');
    expect(
      within(second).getByRole('link', { name: 'Billing sync' }),
    ).toBeVisible();
    expect(
      within(second).queryByRole('button', { name: /Mark .* read/u }),
    ).toBeNull();
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });
  it('marks one notice read with the revision it showed', async () => {
    const actor = userEvent.setup();
    const { reads } = inboxApi({
      threads: [thread(importId), thread(billingId)],
      revision: '7',
    });
    renderApp(`/w/${workspaceId}/inbox`);

    await actor.click(
      await screen.findByRole('button', { name: 'Mark Nightly import read' }),
    );
    await waitFor(() => {
      expect(reads).toEqual([{ workflowId: importId, revision: '7' }]);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark Nightly import read' }),
      ).toBeNull();
    });
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });
  it('marks all read only up to what the list showed', async () => {
    const actor = userEvent.setup();
    const { readAlls } = inboxApi({
      threads: [thread(importId), thread(billingId)],
      revision: '9',
    });
    renderApp(`/w/${workspaceId}/inbox?filter=unread`);

    await screen.findByRole('link', { name: 'Nightly import, unread' });
    await actor.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => {
      expect(readAlls).toEqual([{ revision: '9' }]);
    });
    expect(
      await screen.findByRole('heading', { name: 'You’re caught up' }),
    ).toBeVisible();
  });
  it('refreshes when the workspace reports a new failure', async () => {
    const state = {
      threads: [thread(importId, { unread: false })],
      revision: '7',
    };
    const { stream } = inboxApi(state);
    renderApp(`/w/${workspaceId}/inbox`);

    await screen.findByRole('link', { name: 'Nightly import' });
    state.threads = [
      thread(billingId, { revision: '8' }),
      thread(importId, { unread: false }),
    ];
    state.revision = '8';
    stream.changed('8');
    expect(
      await screen.findByRole('link', { name: 'Billing sync, unread' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
  });
  it('lets a viewer move between its notices and input requests', async () => {
    inboxApi({ threads: [], revision: '1' });
    let failureReads = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace(['run:read']), role: 'viewer' }],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/notifications`, () => {
        failureReads += 1;
        return HttpResponse.json({
          items: [],
          nextCursor: null,
          revision: '1',
        });
      }),
    );
    renderApp(`/w/${workspaceId}/inbox`);
    const views = await screen.findByRole('navigation', {
      name: 'Inbox views',
    });
    expect(
      within(views).getByRole('link', { name: 'Notices' }),
    ).toHaveAttribute('aria-current', 'page');
    await waitFor(() => {
      expect(failureReads).toBeGreaterThan(0);
    });

    await userEvent
      .setup()
      .click(within(views).getByRole('link', { name: 'Requests' }));
    expect(
      await screen.findByRole('heading', { name: 'Nothing is waiting' }),
    ).toBeVisible();
    expect(
      within(screen.getByRole('navigation', { name: 'Inbox views' })).getByRole(
        'link',
        { name: 'Requests' },
      ),
    ).toHaveAttribute('aria-current', 'page');
    expect(spineInbox().getByRole('link', { name: 'Inbox' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
  it('keeps the inbox available to builders', async () => {
    inboxApi({ threads: [], revision: '0' });
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [{ ...workspace([]), role: 'builder' }],
          nextCursor: null,
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/inbox`);

    expect(
      await screen.findByRole('heading', { name: 'Everything finished' }),
    ).toBeVisible();
    expect(spineInbox().getByRole('link', { name: 'Inbox' })).toBeVisible();
  });
});

describe('new failure notice', () => {
  it('announces a workflow that starts failing, not what was already unread', async () => {
    const state = { threads: [thread(billingId)], revision: '7' };
    const { stream } = inboxApi(state);
    renderApp(`/w/${workspaceId}/settings`, { strict: true });

    await waitFor(() => {
      expect(
        spineInbox().getByRole('link', { name: 'Inbox, 1 unread' }),
      ).toBeVisible();
    });
    expect(screen.queryByRole('dialog')).toBeNull();

    state.threads = [
      thread(importId, {
        revision: '8',
        failureDays: [],
        occurrenceCount: 3,
        latestFailedStep: failedStep,
      }),
      thread(billingId),
    ];
    state.revision = '8';
    stream.changed('8');

    const notice = await screen.findByRole('dialog', {
      name: 'Nightly import',
    });
    expect(notice).toHaveTextContent('Failed');
    expect(notice).toHaveTextContent('Failed 3 times since');
    expect(notice).toHaveTextContent('at Fetch orders');
    expect(
      within(notice).getByRole('link', { name: 'Open run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${runId}`);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
  it('gathers failures that arrive together into one notice', async () => {
    const state = { threads: [] as ReturnType<typeof thread>[], revision: '7' };
    const { stream } = inboxApi(state);
    renderApp(`/w/${workspaceId}/settings`);

    await waitFor(() => {
      expect(spineInbox().getByRole('link', { name: 'Inbox' })).toBeVisible();
    });
    state.threads = [
      thread(billingId, { revision: '9' }),
      thread(importId, { revision: '8' }),
    ];
    state.revision = '9';
    stream.changed('9');

    const notice = await screen.findByRole('dialog', {
      name: 'Several workflows are failing',
    });
    expect(notice).toHaveTextContent('Billing sync and Nightly import');
    expect(
      within(notice).getByRole('link', { name: 'Open inbox' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/inbox?filter=unread`);
  });
  it('opens the run from the notice and marks the workflow read', async () => {
    const actor = userEvent.setup();
    const state = { threads: [] as ReturnType<typeof thread>[], revision: '7' };
    const { reads, stream } = inboxApi(state);
    mockServer.use(
      http.get(`${api}/runs/*`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Not found',
            status: 404,
            code: 'run.not_found',
          },
          {
            status: 404,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/settings`);

    await waitFor(() => {
      expect(spineInbox().getByRole('link', { name: 'Inbox' })).toBeVisible();
    });
    state.threads = [thread(importId, { revision: '8' })];
    state.revision = '8';
    stream.changed('8');
    const notice = await screen.findByRole('dialog', {
      name: 'Nightly import',
    });
    await actor.click(within(notice).getByRole('link', { name: 'Open run' }));

    await waitFor(() => {
      expect(reads).toEqual([{ workflowId: importId, revision: '8' }]);
    });
    expect(router.state.location.pathname).toBe(
      `/w/${workspaceId}/runs/${runId}`,
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Nightly import' }),
      ).toBeNull();
    });
  });
});
