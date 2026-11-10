import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  connectionHandler,
  destinationId,
  destinationsUrl,
  identityHandlers,
  lens,
  timestamp,
  workspaceId,
} from './destinations/fixture';

const memberId = '11111111-1111-4111-8111-111111111111';
function arrange(available: boolean) {
  mockServer.use(
    ...identityHandlers(),
    connectionHandler(),
    http.get(destinationsUrl, () =>
      HttpResponse.json({
        items: [],
        systemMail: available
          ? { available: true }
          : {
              available: false,
              reason: 'This server has no system mail configured.',
            },
      }),
    ),
    http.get(`http://pertexo.test/v1/workspaces/${workspaceId}/members`, () =>
      HttpResponse.json({
        items: [
          {
            userId: memberId,
            email: 'ada@example.test',
            displayName: 'Ada',
            role: 'viewer',
            roleRevision: 1,
            membershipStatus: 'active',
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      }),
    ),
  );
}
it('chooses a current member and saves server mail without a connection or free-form address', async () => {
  arrange(true);
  let body: unknown;
  mockServer.use(
    http.post(destinationsUrl, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(
        {
          id: destinationId,
          workspaceId,
          kind: 'system_mail',
          status: 'enabled',
          currentVersion: 1,
          config: body,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { status: 201 },
      );
    }),
  );
  const user = userEvent.setup();
  await renderLoadedApp(`/w/${workspaceId}/alerts`);
  await user.click(
    await screen.findByRole('button', { name: 'Add destination' }),
  );
  await user.click(
    lens().getByRole('button', { name: "Send with this server's mail" }),
  );
  expect(lens().queryByLabelText('Recipient email')).toBeNull();
  expect(lens().queryByLabelText('Email connection')).toBeNull();
  await user.click(lens().getByLabelText('Workspace member'));
  await user.click(
    await screen.findByRole('option', { name: 'Ada · ada@example.test' }),
  );
  await user.click(lens().getByRole('button', { name: 'Add destination' }));
  await waitFor(() => {
    expect(body).toEqual({ kind: 'system_mail', memberId });
  });
});
it('shows the unavailable server-mail option and its reason', async () => {
  arrange(false);
  const user = userEvent.setup();
  await renderLoadedApp(`/w/${workspaceId}/alerts`);
  await user.click(
    await screen.findByRole('button', { name: 'Add destination' }),
  );
  expect(
    lens().getByRole('button', { name: "Send with this server's mail" }),
  ).toBeDisabled();
  expect(
    lens().getByText('This server has no system mail configured.'),
  ).toBeVisible();
});
