import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import {
  base,
  connection,
  connectionId,
  identityHandlers,
  lens,
  listOf,
  testedOk,
  workspaceId,
} from './fixture';

it('configures SMTP, warns about plaintext and tests without requesting a real email', async () => {
  let body: unknown;
  const tests: unknown[] = [];
  const saved = connection('Workspace SMTP', {
    providerKey: 'email',
    authType: 'smtp',
  });
  mockServer.use(
    ...identityHandlers(),
    listOf(() => []),
    http.post(base, async ({ request }) => {
      body = await request.json();
      return HttpResponse.json(saved, { status: 201 });
    }),
    http.post(`${base}/${connectionId}/test`, async ({ request }) => {
      tests.push(await request.json());
      return testedOk(saved);
    }),
  );
  renderApp(`/w/${workspaceId}/connections?add=any`);
  const user = userEvent.setup();
  await screen.findByRole('dialog', { name: 'Add a connection' });
  await user.click(
    lens().getByRole('button', { name: 'Connect Email (SMTP)' }),
  );
  await user.click(lens().getByRole('button', { name: 'Continue' }));
  expect(lens().getByLabelText('SMTP host')).toHaveFocus();
  await user.type(lens().getByLabelText('SMTP host'), 'relay.example.test');
  await user.type(lens().getByLabelText('Username'), 'ada');
  await user.type(lens().getByLabelText('Password'), ' exact SMTP password ');
  await user.type(lens().getByLabelText('From address'), 'alerts@example.test');
  await user.click(lens().getByRole('radio', { name: /^None$/u }));
  expect(
    lens().getByText(/Credentials and email travel without encryption/u),
  ).toBeVisible();
  await user.click(lens().getByRole('radio', { name: 'STARTTLS required' }));
  await user.click(lens().getByRole('button', { name: 'Continue' }));
  await user.clear(lens().getByLabelText('Connection name'));
  await user.type(lens().getByLabelText('Connection name'), 'Workspace SMTP');
  await user.click(lens().getByRole('button', { name: 'Save and test' }));
  await waitFor(() => {
    expect(tests).toEqual([{ providerKey: 'email', transport: 'smtp' }]);
  });
  expect(body).toMatchObject({
    providerKey: 'email',
    credential: {
      type: 'smtp',
      host: 'relay.example.test',
      port: 587,
      security: 'starttls',
      password: ' exact SMTP password ',
    },
  });
  expect(
    lens().queryByRole('checkbox', { name: 'Send a real test email' }),
  ).not.toBeInTheDocument();
  expect(await lens().findByText('SMTP connection works.')).toBeVisible();
});
