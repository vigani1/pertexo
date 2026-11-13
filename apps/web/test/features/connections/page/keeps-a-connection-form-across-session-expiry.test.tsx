import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  base,
  identityHandlers,
  lens,
  listOf,
  user,
  workspaceId,
} from './fixture';

function ended() {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Session ended',
      status: 401,
      code: 'auth.unauthenticated',
      requestId: 'connection-pause',
    },
    { status: 401, headers: { 'content-type': 'application/problem+json' } },
  );
}

// The J6a session pause: a form in a sheet (a portal outside the page) is
// hidden with the page and comes back as it was.
it('keeps a half-made connection, sheet and all, across an ended session', async () => {
  let signedIn = true;
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
  );
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () =>
      signedIn ? HttpResponse.json(user) : ended(),
    ),
    http.post(base, () => ended()),
  );
  await renderLoadedApp(`/w/${workspaceId}/connections`);
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Add connection' }),
  );
  await event.click(lens().getByRole('button', { name: 'Connect Slack' }));
  await event.type(
    lens().getByLabelText('Slack bot token'),
    'xoxb-1234567890-kept',
  );
  await event.click(lens().getByRole('button', { name: 'Continue' }));
  const name = lens().getByLabelText('Connection name');
  await event.clear(name);
  await event.type(name, 'Kept Slack');
  signedIn = false;
  await event.click(lens().getByRole('button', { name: 'Save and test' }));

  expect(
    await screen.findByRole('heading', { name: 'Your session ended' }),
  ).toBeVisible();
  expect(screen.queryByRole('dialog')).toBeNull();

  signedIn = true;
  await event.click(screen.getByRole('button', { name: 'Continue' }));
  expect(await screen.findByLabelText('Connection name')).toHaveValue(
    'Kept Slack',
  );
  expect(lens().getByRole('button', { name: 'Save and test' })).toBeVisible();
});
