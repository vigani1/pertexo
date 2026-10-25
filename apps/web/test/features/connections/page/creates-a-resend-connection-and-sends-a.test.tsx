import { connectionKeys } from '@/features/connections/data/connections.queries';

import { act, screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { problem } from '../../../support/fixtures/team';

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
  secretVersionId,
  testedOk,
  userId,
  workspaceId,
} from './fixture';

describe('connections page', () => {
  it('creates a Resend connection and sends a test email only after it is allowed', async () => {
    const tests: unknown[] = [];
    let createBody: unknown;
    mockServer.use(
      ...identityHandlers(),
      listOf(() => []),
      http.post(base, async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json(
          connection('Receipts', { providerKey: 'email' }),
          { status: 201 },
        );
      }),
      http.post(`${base}/${connectionId}/test`, async ({ request }) => {
        tests.push(await request.json());
        return testedOk(connection('Receipts', { providerKey: 'email' }));
      }),
    );

    renderApp(`/w/${workspaceId}/connections?add=email`);
    const event = userEvent.setup();
    await event.type(
      await screen.findByLabelText('Resend API key'),
      'sk_wrong',
    );
    await event.type(
      lens().getByLabelText('From address'),
      'billing@northwind',
    );
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    expect(lens().getByLabelText('Resend API key')).toHaveFocus();
    expect(lens().getByText('Resend API keys start with re_.')).toBeVisible();
    expect(lens().getByText(/isn’t a complete email address/u)).toBeVisible();
    await event.clear(lens().getByLabelText('Resend API key'));
    await event.type(lens().getByLabelText('Resend API key'), 're_live_123456');
    await event.clear(lens().getByLabelText('From address'));
    await event.type(
      lens().getByLabelText('From address'),
      'billing@Northwind.dev',
    );
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    const name = lens().getByLabelText('Connection name');
    await event.clear(name);
    await event.type(name, 'Receipts');
    await event.click(lens().getByRole('button', { name: 'Save and test' }));

    await event.click(
      await lens().findByRole('button', { name: 'Send test email' }),
    );
    expect(
      lens().getByText('Tick this to allow the test email.'),
    ).toBeVisible();
    expect(tests).toHaveLength(0);
    await event.click(
      lens().getByRole('checkbox', { name: 'Send a real test email' }),
    );
    await event.click(lens().getByRole('button', { name: 'Send test email' }));
    expect(
      await lens().findByText('Resend accepted the test email.'),
    ).toBeVisible();
    expect(createBody).toEqual({
      providerKey: 'email',
      name: 'Receipts',
      credential: {
        type: 'resend_api_key',
        apiKey: 're_live_123456',
        fromEmail: 'billing@northwind.dev',
      },
    });
    expect(tests).toEqual([
      { providerKey: 'email', sideEffectDisclosureAccepted: true },
    ]);
  });
  it('opens the detail lens from the single-connection read and repeats an unconfirmed test with the same key', async () => {
    const keys: string[] = [];
    let detailReads = 0;
    mockServer.use(
      ...identityHandlers(),
      listOf(() => [connection('Operations Slack')]),
      http.get(`${base}/${connectionId}`, () => {
        detailReads += 1;
        return HttpResponse.json(
          connection('Operations Slack', {
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: null,
            },
          }),
        );
      }),
      http.post(`${base}/${connectionId}/test`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '');
        expect(await request.json()).toEqual({ providerKey: 'slack' });
        if (keys.length === 1) return HttpResponse.error();
        return testedOk(connection('Operations Slack'));
      }),
    );

    const { router } = renderApp(`/w/${workspaceId}/connections`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /Operations Slack, Unknown/u }),
    );
    expect(router.state.location.search).toEqual({ connection: connectionId });
    await waitFor(() => {
      expect(detailReads).toBeGreaterThan(0);
    });
    expect(
      lens().queryByRole('button', { name: 'Revoke connection' }),
    ).toBeNull();
    await event.click(lens().getByRole('button', { name: 'Test' }));
    await event.click(lens().getByRole('button', { name: 'Test connection' }));
    expect(
      await lens().findByText(/We couldn’t confirm the test result/u),
    ).toBeVisible();
    await event.click(lens().getByRole('button', { name: 'Test again' }));
    expect(await lens().findByText('Slack accepted the token.')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });
  it('keeps a credential edit at its original version across refresh until a newer replacement is explicitly chosen', async () => {
    const nextVersion = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const nextToken = 'xoxb-1234567890-refresh-retained';
    let current = connection('Operations Slack');
    const keys: string[] = [];
    const bodies: unknown[] = [];
    mockServer.use(
      ...identityHandlers(),
      listOf(() => [current]),
      detailOf(() => current),
      http.put(`${base}/${connectionId}/secret`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '');
        bodies.push(await request.json());
        if (keys.length === 1) return problem(409, 'connection.conflict');
        current = connection('Operations Slack', {
          secretVersionId: '99999999-9999-4999-8999-999999999999',
        });
        return HttpResponse.json(current);
      }),
    );
    const { queryClient } = renderApp(
      `/w/${workspaceId}/connections?connection=${connectionId}`,
    );
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Replace credential' }),
    );
    const token = lens().getByLabelText('Slack bot token');
    await actor.type(token, nextToken);
    current = connection('Operations Slack', { secretVersionId: nextVersion });
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: connectionKeys.scope(userId, workspaceId),
      });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(
          connectionKeys.detail(userId, workspaceId, connectionId),
        ),
      ).toMatchObject({ secretVersionId: nextVersion });
    });
    expect(token).toHaveValue(nextToken);
    await actor.click(
      lens().getByRole('button', { name: 'Replace credential' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });
    expect(bodies[0]).toEqual({
      expectedSecretVersionId: secretVersionId,
      credential: { type: 'slack_bot_token', botToken: nextToken },
    });
    expect(
      await lens().findByText(/different credential was saved/u),
    ).toBeVisible();
    expect(token).toHaveValue(nextToken);
    await actor.click(
      lens().getByRole('button', { name: 'Use my credential' }),
    );
    expect(
      await screen.findByText('Replaced the bot token for Operations Slack'),
    ).toBeVisible();
    expect(bodies[1]).toEqual({
      expectedSecretVersionId: nextVersion,
      credential: { type: 'slack_bot_token', botToken: nextToken },
    });
    expect(keys[1]).not.toBe(keys[0]);
    expect(mutationVariables(queryClient)).not.toContain(nextToken);
  });
  it('replaces a credential with its original secret version and command key', async () => {
    const nextToken = 'xoxb-1234567890-rotated';
    const keys: string[] = [];
    const bodies: unknown[] = [];
    mockServer.use(
      ...identityHandlers(),
      listOf(() => [connection('Operations Slack')]),
      detailOf(() => connection('Operations Slack')),
      http.put(`${base}/${connectionId}/secret`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '');
        bodies.push(await request.json());
        if (keys.length === 1) return HttpResponse.error();
        return HttpResponse.json(
          connection('Operations Slack', {
            secretVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          }),
        );
      }),
    );

    const { queryClient } = renderApp(
      `/w/${workspaceId}/connections?connection=${connectionId}`,
      { strict: true },
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Replace credential' }),
    );
    const tokenInput = lens().getByLabelText('Slack bot token');
    await event.click(
      lens().getByRole('button', { name: 'Replace credential' }),
    );
    expect(tokenInput).toHaveFocus();
    await event.type(tokenInput, nextToken);
    await event.click(
      lens().getByRole('button', { name: 'Replace credential' }),
    );
    expect(
      await lens().findByText(
        /couldn’t confirm whether the new credential was saved/u,
      ),
    ).toBeVisible();
    await event.click(lens().getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Replaced the bot token for Operations Slack'),
    ).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      expectedSecretVersionId: secretVersionId,
      credential: {
        type: 'slack_bot_token',
        botToken: nextToken,
      },
    });
    expect(mutationVariables(queryClient)).not.toContain(nextToken);
  });
});
