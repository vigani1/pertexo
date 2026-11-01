import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import {
  connectionHandler,
  destination,
  destinationId,
  destinationsOf,
  identityHandlers,
  lens,
  workspace,
  workspaceId,
} from '../../failure-notifications/destinations/fixture';
import { api, inboxApi, thread } from './fixture';

const alertNotice = {
  id: destinationId,
  noticeKind: 'failure_alert_attention',
  subjectId: destinationId,
  workflowId: null,
  name: 'Slack',
  details: {},
  limits: [],
  occurrenceCount: 1,
  firstOccurredAt: '2026-09-15T09:00:00.000000Z',
  latestOccurredAt: '2026-09-15T09:30:00.000000Z',
  revision: '7',
  unread: true,
} as unknown as ReturnType<typeof thread>;

const reader = {
  ...workspace,
  capabilities: [...workspace.capabilities, 'notification:read'],
};

function inboxWithNotice(items: () => ReturnType<typeof destination>[]) {
  inboxApi({ threads: [alertNotice], revision: '7' });
  mockServer.use(
    ...identityHandlers(reader),
    connectionHandler(),
    destinationsOf(items),
  );
}

const noticeLink = () =>
  screen.findByRole('link', { name: /Failure alerts aren’t reaching Slack/u });

describe('the failure alert notice in the Inbox', () => {
  it('can be picked out with the filter', async () => {
    const asked: (string | null)[] = [];
    inboxApi({
      threads: [thread('cccccccc-cccc-4ccc-8ccc-cccccccccccc')],
      revision: '7',
    });
    mockServer.use(
      http.get(`${api}/notifications`, ({ request }) => {
        const noticeKind = new URL(request.url).searchParams.get('noticeKind');
        asked.push(noticeKind);
        return HttpResponse.json({
          items: noticeKind === 'failure_alert_attention' ? [alertNotice] : [],
          nextCursor: null,
          revision: '7',
        });
      }),
    );
    renderApp(`/w/${workspaceId}/inbox`);
    const actor = userEvent.setup();

    await actor.click(
      await screen.findByRole('combobox', { name: 'Show notices about' }),
    );
    await actor.click(
      await screen.findByRole('option', {
        name: 'Failure alerts not delivered',
      }),
    );

    expect(await noticeLink()).toBeVisible();
    expect(asked).toContain('failure_alert_attention');
  });

  it('opens the destination’s edit sheet with the keyboard alone', async () => {
    inboxWithNotice(() => [destination()]);
    const { router } = renderApp(`/w/${workspaceId}/inbox`);
    const actor = userEvent.setup({ pointerEventsCheck: 0 });
    const link = await noticeLink();

    for (
      let press = 0;
      press < 80 && document.activeElement !== link;
      press += 1
    )
      await actor.tab();
    expect(link).toHaveFocus();
    await actor.keyboard('{Enter}');

    const sheet = await screen.findByRole('dialog');
    expect(
      await within(sheet).findByRole('heading', { name: /edit/iu }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe(
      `/w/${workspaceId}/settings/alerts`,
    );
  });

  it('leads to a working page, without a sheet, once the destination is gone', async () => {
    inboxWithNotice(() => []);
    renderApp(`/w/${workspaceId}/inbox`);
    const actor = userEvent.setup();

    await actor.click(await noticeLink());

    expect(
      await screen.findByRole('heading', { name: 'No alert destinations yet' }),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    await actor.click(screen.getByRole('button', { name: 'Add destination' }));
    expect(await lens().findByRole('heading', { name: /add/iu })).toBeVisible();
  });
});

describe('a link to a destination on the Alerts page', () => {
  const linked = `/w/${workspaceId}/settings/alerts?destination=${destinationId}`;
  const otherId = 'abababab-abab-4bab-8bab-abababababab';

  it('opens no sheet, and never the add form, for an id it does not know', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
    );
    renderApp(`/w/${workspaceId}/settings/alerts?destination=${otherId}`);

    expect(
      await screen.findByText('#C0123456789 via Incident Slack'),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['a viewer', ['workspace:read']],
    ['an operator', ['workspace:read', 'connection:read', 'notification:read']],
    ['a builder', ['workspace:read', 'workflow:update', 'connection:read']],
  ])('opens no sheet for %s', async (_who, capabilities) => {
    mockServer.use(
      ...identityHandlers({ ...workspace, capabilities }),
      connectionHandler(),
      destinationsOf(() => [destination()]),
    );
    const { router } = renderApp(linked);

    await waitFor(() => {
      expect(router.state.status).toBe('idle');
    });
    await expect(
      screen.findByRole('dialog', undefined, { timeout: 300 }),
    ).rejects.toThrow();
  });

  it('drops the link when closed, so a reload stays closed', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
    );
    const { router, unmount } = renderApp(linked);
    const actor = userEvent.setup();
    await screen.findByRole('dialog');

    await actor.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    const { href } = router.state.location;
    unmount();
    renderApp(href);
    expect(
      await screen.findByText('#C0123456789 via Incident Slack'),
    ).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drops the link when saved', async () => {
    mockServer.use(
      ...identityHandlers(),
      connectionHandler(),
      destinationsOf(() => [destination()]),
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/failure-notification-destinations/${destinationId}/versions`,
        () => HttpResponse.json(destination('C9876543210', 2)),
      ),
    );
    const { router } = renderApp(linked);
    const actor = userEvent.setup();
    await screen.findByRole('dialog');
    const channel = await lens().findByLabelText('Channel ID');

    await actor.clear(channel);
    await actor.type(channel, 'C9876543210');
    await actor.click(lens().getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    // The saved toast is a dialog too, so this asks for the sheet by name.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    });
  });
});
