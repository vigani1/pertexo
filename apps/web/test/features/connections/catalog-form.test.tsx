import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { browserConnectionDefinitions } from '../../support/fixtures/node-catalog';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import { identityHandlers, lens, listOf, workspaceId } from './page/fixture';

it('uses the server catalog for the picker tile and the masked credential control', async () => {
  const slack = browserConnectionDefinitions.find(
    ({ authType }) => authType === 'slack_bot_token',
  );
  if (slack === undefined)
    throw new Error('Slack is missing from the connection catalog');
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
    http.get('http://pertexo.test/v1/node-definitions', () =>
      HttpResponse.json({
        items: [],
        connections: [
          {
            ...slack,
            presentation: { ...slack.presentation, name: 'Workspace chat' },
            fields: {
              type: 'object',
              properties: {
                botToken: {
                  type: 'string',
                  title: 'Workspace token',
                  secret: true,
                },
                backupToken: {
                  type: 'string',
                  title: 'Backup token',
                  description: 'Used when the primary token expires.',
                  secret: true,
                },
                workspace: { type: 'string', title: 'Workspace' },
              },
              required: ['botToken'],
            },
          },
        ],
      }),
    ),
  );
  await renderLoadedApp(`/w/${workspaceId}/connections`);
  await userEvent.click(
    await screen.findByRole('button', { name: 'Connect Workspace chat' }),
  );
  expect(lens().getByLabelText('Workspace token')).toHaveAttribute(
    'type',
    'password',
  );
  const secretDescription =
    'Stored encrypted. Nobody, including you, can see it again.';
  expect(lens().getByLabelText('Workspace token')).toHaveAccessibleDescription(
    secretDescription,
  );
  expect(lens().getByLabelText(/Backup token/u)).toHaveAccessibleDescription(
    `Used when the primary token expires. ${secretDescription}`,
  );
  expect(lens().getByLabelText('Workspace')).not.toHaveAccessibleDescription();
  expect(
    screen.queryByRole('button', { name: 'Connect Slack' }),
  ).not.toBeInTheDocument();
});

it('preserves the PostgreSQL defaults and shows the CA field only with Verify full', async () => {
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
  );
  await renderLoadedApp(`/w/${workspaceId}/connections?add=postgres`);
  expect(lens().getByLabelText('Port')).toHaveValue('5432');
  expect(lens().getByLabelText('Password')).toHaveAttribute('type', 'password');
  expect(lens().getByRole('radio', { name: 'Require' })).toBeChecked();
  expect(
    lens().getByRole('checkbox', { name: 'Read-only connection' }),
  ).not.toBeChecked();
  expect(
    lens().queryByLabelText('CA certificate (optional)'),
  ).not.toBeInTheDocument();
  await userEvent.click(lens().getByRole('radio', { name: 'Verify full' }));
  expect(lens().getByLabelText('CA certificate (optional)')).toHaveValue('');
});

it.each([
  {
    choice: 'slack',
    steps: [
      'Open api.slack.com/apps and pick your app, or create one for Pertexo.',
      'Under OAuth & Permissions, add the chat:write scope and install the app.',
      'Copy the Bot User OAuth Token. It starts with xoxb-.',
      'In Slack, invite the bot to each channel it should post in.',
    ],
  },
  {
    choice: 'email',
    steps: [
      'Open resend.com/api-keys and create an API key.',
      'Give it Sending access. Full access isn’t needed.',
      'Copy the key. It starts with re_ and is only shown once.',
      'Use a from address on a domain you verified in Resend.',
    ],
  },
])('preserves credential setup help for $choice', async ({ choice, steps }) => {
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
  );
  await renderLoadedApp(`/w/${workspaceId}/connections?add=${choice}`);
  await userEvent.click(await lens().findByText('Where do I find this?'));
  for (const step of steps) expect(lens().getByText(step)).toBeVisible();
});

it('ignores a deep link to a choice missing from the catalog', async () => {
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
  );
  await renderLoadedApp(`/w/${workspaceId}/connections?add=future_provider`);
  expect(
    await screen.findByRole('button', { name: 'Connect Slack' }),
  ).toBeVisible();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
