import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  base,
  connection,
  connectionId,
  detailOf,
  identityHandlers,
  lens,
  listOf,
  mutationVariables,
  testedOk,
  workspaceId,
} from './fixture';

describe('connections page', () => {
  it('validates a Slack token, retries the exact uncertain create, then tests it straight away', async () => {
    const token = 'xoxb-1234567890-secret';
    const keys: string[] = [];
    const testKeys: string[] = [];
    let created = false;
    mockServer.use(
      ...identityHandlers(),
      listOf(() => (created ? [connection('Operations Slack')] : [])),
      http.post(base, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '');
        expect(request.headers.get('x-csrf-token')).toBe(
          'csrf-token-for-component-tests-12345678901234567890',
        );
        expect(await request.json()).toEqual({
          providerKey: 'slack',
          name: 'Operations Slack',
          credential: {
            type: 'slack_bot_token',
            botToken: token,
          },
        });
        if (keys.length === 1) return HttpResponse.error();
        created = true;
        return HttpResponse.json(connection('Operations Slack'), {
          status: 201,
        });
      }),
      http.post(`${base}/${connectionId}/test`, async ({ request }) => {
        testKeys.push(request.headers.get('idempotency-key') ?? '');
        expect(await request.json()).toEqual({ providerKey: 'slack' });
        return testedOk(connection('Operations Slack'));
      }),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/connections`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Add connection' }),
    );
    await event.click(lens().getByRole('button', { name: 'Connect Slack' }));
    const tokenInput = lens().getByLabelText('Slack bot token');
    await event.click(tokenInput);
    await event.tab();
    expect(tokenInput).toHaveAttribute('aria-invalid', 'false');
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    expect(tokenInput).toHaveFocus();
    expect(
      await lens().findByText('Paste the bot token from your Slack app.'),
    ).toBeVisible();
    await event.type(tokenInput, 'wrong');
    expect(lens().getByText(/start with xoxb-/u)).toBeVisible();
    await event.clear(tokenInput);
    expect(tokenInput).toHaveAttribute('aria-invalid', 'true');
    await event.type(tokenInput, token);
    expect(tokenInput).toHaveAttribute('aria-invalid', 'false');
    await event.click(lens().getByRole('button', { name: 'Continue' }));

    const nameInput = lens().getByLabelText('Connection name');
    expect(nameInput).toHaveValue('Control Operations Slack');
    await event.clear(nameInput);
    await event.click(lens().getByRole('button', { name: 'Save and test' }));
    expect(nameInput).toHaveFocus();
    expect(nameInput).toHaveAccessibleDescription(
      expect.stringContaining('Name this connection'),
    );
    await event.type(nameInput, '  Operations Slack  ');
    await event.click(lens().getByRole('button', { name: 'Save and test' }));
    expect(await lens().findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether Operations Slack was saved',
    );
    await event.click(lens().getByRole('button', { name: 'Try again' }));
    expect(await lens().findByText('Slack accepted the token.')).toBeVisible();
    // The summary names what was stored without ever showing it whole.
    const summary = lens().getByRole('region', { name: 'Summary' });
    expect(summary).toHaveTextContent('NameOperations Slack');
    expect(summary).toHaveTextContent('Tokenxoxb-••••••••cret');
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(testKeys).toHaveLength(1);
    expect(screen.queryByDisplayValue(token)).not.toBeInTheDocument();
    expect(mutationVariables(queryClient)).not.toContain(token);
    // The result shows in place, so no toast covers the lens's Done.
    expect(screen.queryByText(/passed its test/u)).toBeNull();

    await event.click(lens().getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Connected Operations Slack')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Operations Slack, Unknown/u }),
    ).toBeVisible();
  });
  it('removes a pending credential command from the mutation cache on unmount', async () => {
    const token = 'xoxb-1234567890-pending';
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockServer.use(
      ...identityHandlers(),
      listOf(() => []),
      http.post(base, async () => {
        await gate;
        return HttpResponse.json(connection('Pending Slack'), { status: 201 });
      }),
    );

    const rendered = renderApp(`/w/${workspaceId}/connections?add=slack`);
    const event = userEvent.setup();
    await event.type(await screen.findByLabelText('Slack bot token'), token);
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    await event.click(lens().getByRole('button', { name: 'Save and test' }));
    await waitFor(() => {
      expect(mutationVariables(rendered.queryClient)).toContain(token);
    });
    rendered.unmount();
    expect(mutationVariables(rendered.queryClient)).not.toContain(token);
    release?.();
  });
  it('drops an uncertain credential command and its values when the lens closes', async () => {
    const token = 'xoxb-1234567890-discard';
    mockServer.use(
      ...identityHandlers(),
      listOf(() => []),
      http.post(base, () => HttpResponse.error()),
    );

    const { queryClient } = renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Connect Slack' }),
    );
    await event.type(lens().getByLabelText('Slack bot token'), token);
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    await event.click(lens().getByRole('button', { name: 'Save and test' }));
    await lens().findByRole('button', { name: 'Try again' });
    expect(mutationVariables(queryClient)).toContain(token);

    // The pasted token isn't saved, so leaving asks first.
    await event.keyboard('{Escape}');
    const discard = await screen.findByRole('dialog', {
      name: 'Discard this connection?',
    });
    await event.click(within(discard).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).not.toBeInTheDocument();
    });
    expect(mutationVariables(queryClient)).not.toContain(token);
    await event.click(screen.getByRole('button', { name: 'Connect Slack' }));
    expect(lens().getByLabelText('Slack bot token')).toHaveValue('');
    expect(lens().queryByRole('alert')).not.toBeInTheDocument();
  });
  it('creates an HTTP connection with masked headers and tests it against an https address', async () => {
    const bodies: unknown[] = [];
    mockServer.use(
      ...identityHandlers(),
      listOf(() => []),
      http.post(base, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(
          connection('Billing API', { providerKey: 'http' }),
          { status: 201 },
        );
      }),
      http.post(`${base}/${connectionId}/test`, async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({
          connection: connection('Billing API', { providerKey: 'http' }),
          outcome: {
            ok: false,
            httpStatus: 401,
            errorCode: 'connection.credential_rejected',
          },
        });
      }),
    );

    renderApp(`/w/${workspaceId}/connections?add=http`);
    const event = userEvent.setup();
    const firstValue = await screen.findByLabelText('Header 1 value');
    expect(firstValue).toHaveAttribute('type', 'password');
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    expect(firstValue).toHaveFocus();
    expect(lens().getByText('Enter this header’s value.')).toBeVisible();
    await event.type(firstValue, 'Bearer secret-value');
    await event.click(lens().getByRole('button', { name: 'Add header' }));
    await event.type(lens().getByLabelText('Header 2 name'), 'authorization');
    await event.type(lens().getByLabelText('Header 2 value'), 'x');
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    expect(lens().getByText('This header is already listed.')).toBeVisible();
    await event.clear(lens().getByLabelText('Header 2 name'));
    await event.type(lens().getByLabelText('Header 2 name'), 'X-Team');
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    const name = lens().getByLabelText('Connection name');
    await event.clear(name);
    await event.type(name, 'Billing API');
    await event.click(lens().getByRole('button', { name: 'Save and test' }));

    const address = await lens().findByLabelText('Address to call');
    await event.type(address, 'http://billing.example.test');
    await event.click(
      lens().getByRole('button', { name: 'Call this address' }),
    );
    expect(address).toHaveAccessibleDescription(
      expect.stringContaining('full https:// address'),
    );
    await event.clear(address);
    await event.type(address, 'https://billing.example.test/me');
    await event.click(
      lens().getByRole('button', { name: 'Call this address' }),
    );
    expect(
      await lens().findByText('The API refused these headers.'),
    ).toBeVisible();
    expect(lens().getByRole('button', { name: 'Done' })).toBeVisible();
    expect(bodies).toEqual([
      {
        providerKey: 'http',
        name: 'Billing API',
        credential: {
          type: 'http_headers',
          headers: { authorization: 'Bearer secret-value', 'x-team': 'x' },
        },
      },
      { url: 'https://billing.example.test/me' },
    ]);
    expect(
      screen.queryByDisplayValue('Bearer secret-value'),
    ).not.toBeInTheDocument();
  });
  it('keeps the completed DNS failure visible after leaving add-connection setup', async () => {
    let created = false;
    let current = connection('Billing API', { providerKey: 'http' });
    mockServer.use(
      ...identityHandlers(),
      listOf(() => (created ? [current] : [])),
      detailOf(() => current),
      http.post(base, () => {
        created = true;
        return HttpResponse.json(current, { status: 201 });
      }),
      http.post(`${base}/${connectionId}/test`, () => {
        current = connection('Billing API', {
          providerKey: 'http',
          health: {
            lastTestedAt: '2026-09-24T10:00:00.000Z',
            lastHealthyAt: null,
            lastErrorCode: 'connection.test.dns_failed',
          },
        });
        return HttpResponse.json({
          connection: current,
          outcome: {
            ok: false,
            httpStatus: null,
            errorCode: 'connection.test.dns_failed',
          },
        });
      }),
    );
    renderApp(`/w/${workspaceId}/connections?add=http`, { strict: true });
    const actor = userEvent.setup();
    await actor.type(
      await screen.findByLabelText('Header 1 value'),
      'Bearer setup-secret',
    );
    await actor.click(lens().getByRole('button', { name: 'Continue' }));
    await actor.clear(lens().getByLabelText('Connection name'));
    await actor.type(lens().getByLabelText('Connection name'), 'Billing API');
    await actor.click(lens().getByRole('button', { name: 'Save and test' }));
    await actor.type(
      await lens().findByLabelText('Address to call'),
      'https://billing.example.test/me',
    );
    await actor.click(
      lens().getByRole('button', { name: 'Call this address' }),
    );
    expect(
      await lens().findByText('The test failed: address not found.'),
    ).toBeVisible();
    // Already saved before the test ran, so the way out is Done.
    await actor.click(lens().getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText('last test failed · address not found'),
    ).toBeVisible();
    expect(screen.queryByText('never tested')).not.toBeInTheDocument();
    await actor.click(
      screen.getByRole('button', { name: /Billing API, Unknown/u }),
    );
    expect(await lens().findByText('Last tested')).toBeVisible();
    expect(
      lens().getByText('Last tested').nextElementSibling,
    ).not.toHaveTextContent('Never');
  });
});
