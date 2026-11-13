import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderLoadedApp } from '../support/render-app';
import {
  api,
  firstMemberId,
  identityHandlers,
  member,
  noInvitations,
  ownerWorkspace,
  problem,
  userId,
  workspaceId,
} from '../support/fixtures/team';
import { coldStart } from '../support/fixtures/run';
import { createUserFixture } from '../support/fixtures/identity';

it('clears the previous account’s data when the paused page finds a different signed-in person', async () => {
  let changed = false,
    refused = false;
  const nextUser = createUserFixture({
    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    displayName: 'New Owner',
  });
  mockServer.use(
    ...identityHandlers(ownerWorkspace),
    noInvitations(),
    http.get(`${api}/members`, () => {
      if (changed && !refused) {
        refused = true;
        return problem(401, 'auth.unauthenticated');
      }
      return HttpResponse.json({
        items: [member(firstMemberId, 'Directory member', 'viewer')],
        nextCursor: null,
      });
    }),
  );
  const app = await renderLoadedApp(`/w/${workspaceId}/team`);
  await screen.findByText('Directory member', {}, coldStart);
  app.queryClient.setQueryData(['protected', userId], {
    private: 'previous account',
  });
  changed = true;
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () =>
      HttpResponse.json(nextUser),
    ),
  );
  await app.queryClient.refetchQueries({
    queryKey: ['identity', userId, 'workspace', workspaceId, 'members'],
  });
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'Continue' }));
  expect(
    await screen.findByText('Signed in as a different account'),
  ).toBeVisible();
  await waitFor(() => {
    expect(app.queryClient.getQueryData(['protected', userId])).toBeUndefined();
  });
  expect(
    await screen.findByRole('button', { name: 'Account menu for New Owner' }),
  ).toBeVisible();
  expect(app.router.state.location.pathname).toBe(`/w/${workspaceId}/team`);
});
