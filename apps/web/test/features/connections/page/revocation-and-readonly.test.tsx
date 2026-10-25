import { screen, waitFor } from '@testing-library/react';

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
  secretVersionId,
  testedOk,
  workspace,
  workspaceId,
} from './fixture';

describe('connections page', () => {
  it.each([
    [
      'connection.conflict',
      'Someone replaced this credential meanwhile. Close this and start again from the latest version.',
    ],
    [
      'request.idempotency_conflict',
      'This request was already used with different details. Start again.',
    ],
  ] as const)(
    'keeps the submitted replacement credential and retry identity after %s',
    async (code, feedback) => {
      const nextToken = 'xoxb-1234567890-conflict-retained';
      const keys: string[] = [];
      const bodies: unknown[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockServer.use(
        ...identityHandlers(),
        listOf(() => [connection('Operations Slack')]),
        detailOf(() => connection('Operations Slack')),
        http.put(`${base}/${connectionId}/secret`, async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          bodies.push(await request.json());
          if (keys.length === 1) {
            await held;
            return HttpResponse.json(
              {
                type: `urn:pertexo:problem:${code}`,
                title: 'Conflict',
                status: 409,
                code,
                requestId: 'replace-credential-conflict',
              },
              {
                status: 409,
                headers: { 'content-type': 'application/problem+json' },
              },
            );
          }
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
      await event.type(tokenInput, nextToken);
      await event.click(
        lens().getByRole('button', { name: 'Replace credential' }),
      );
      await waitFor(() => {
        expect(keys).toHaveLength(1);
      });
      expect(tokenInput).toBeDisabled();
      expect(tokenInput).toHaveValue(nextToken);
      expect(mutationVariables(queryClient)).toContain(nextToken);
      release();
      expect(await lens().findByText(feedback)).toBeVisible();
      expect(tokenInput).toBeEnabled();
      expect(tokenInput).toHaveValue(nextToken);
      expect(mutationVariables(queryClient)).toContain(nextToken);
      await event.click(
        lens().getByRole('button', { name: 'Replace credential' }),
      );
      expect(
        await screen.findByText('Replaced the bot token for Operations Slack'),
      ).toBeVisible();
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe('');
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
    },
  );
  it('revokes from the detail lens after confirmation and files it under Revoked', async () => {
    let revoked = false;
    let commands = 0;
    const current = () =>
      connection('Operations Slack', {
        status: revoked ? 'revoked' : 'active',
      });
    mockServer.use(
      ...identityHandlers(),
      listOf(() => [current()]),
      detailOf(current),
      http.delete(`${base}/${connectionId}`, () => {
        commands += 1;
        revoked = true;
        return HttpResponse.json(current());
      }),
    );

    renderApp(`/w/${workspaceId}/connections?connection=${connectionId}`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(screen.getByText(/Past runs keep their history/u)).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Keep connection' }));
    expect(commands).toBe(0);
    await event.click(screen.getByRole('button', { name: 'Revoke' }));
    await event.click(
      screen.getByRole('button', { name: 'Revoke connection' }),
    );
    expect(await screen.findByText('Revoked Operations Slack')).toBeVisible();
    expect(commands).toBe(1);
    await event.keyboard('{Escape}');
    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="sheet-content"]'),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText(
        'Every connection here has been revoked. Add a new one to use it again.',
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: /Revoked/u }));
    expect(
      screen.getByRole('button', { name: /Operations Slack, Revoked/u }),
    ).toBeVisible();
  });
  it('keeps read-only access free of management controls', async () => {
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'viewer',
        capabilities: ['workspace:read', 'connection:read'],
      }),
      listOf(() => [connection('Read only Slack')]),
      detailOf(() => connection('Read only Slack')),
    );
    renderApp(`/w/${workspaceId}/connections`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: /Read only Slack/u }),
    );
    expect(await lens().findByText('Service')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /add connection|connect slack/iu }),
    ).not.toBeInTheDocument();
    for (const name of ['Test', 'Replace credential', 'Revoke'])
      expect(lens().queryByRole('button', { name })).not.toBeInTheDocument();
  });
  it('keeps a failed list distinct from an empty workspace and offers retry', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(base, () => HttpResponse.error()),
    );
    renderApp(`/w/${workspaceId}/connections`);
    expect(
      await screen.findByRole('heading', {
        name: 'Connections couldn’t be loaded',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('heading', { name: 'Nothing connected yet' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
  it('does not request connection data without read permission', async () => {
    let reads = 0;
    mockServer.use(
      ...identityHandlers({
        ...workspace,
        role: 'viewer',
        capabilities: ['workspace:read'],
      }),
      http.get(base, () => {
        reads += 1;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );
    renderApp(`/w/${workspaceId}/connections`);
    expect(
      await screen.findByText(
        'Your role (Viewer) can’t see this workspace’s connections. Operators, builders, admins and owners can.',
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(reads).toBe(0);
    });
  });
});

it('retries an accepted-then-503 email test without dispatching a second email', async () => {
  const current = connection('Notification email', { providerKey: 'email' });
  const deliveries = new Set<string>();
  const writes: { key: string | null; body: unknown }[] = [];
  mockServer.use(
    ...identityHandlers(),
    listOf(() => [current]),
    detailOf(() => current),
    http.get(`${base}/${connectionId}/sharing`, () =>
      HttpResponse.json({
        connectionId,
        mode: 'workspace',
        revision: 1,
        members: [],
      }),
    ),
    http.post(`${base}/${connectionId}/test`, async ({ request }) => {
      const key = request.headers.get('idempotency-key');
      writes.push({ key, body: await request.json() });
      if (key !== null) deliveries.add(key);
      if (writes.length === 1)
        return HttpResponse.json(
          {
            type: 'urn:pertexo:problem:request.rate_limit_unavailable',
            title: 'Service unavailable',
            code: 'request.rate_limit_unavailable',
            status: 503,
            requestId: 'accepted-test-request',
          },
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      return testedOk(current);
    }),
  );
  const event = userEvent.setup();
  renderApp(`/w/${workspaceId}/connections?connection=${connectionId}`);
  await event.click(await screen.findByRole('button', { name: 'Test' }));
  await event.click(
    await screen.findByRole('checkbox', { name: 'Send a real test email' }),
  );
  await event.click(lens().getByRole('button', { name: 'Send test email' }));
  await event.click(await lens().findByRole('button', { name: 'Test again' }));
  await waitFor(() => {
    expect(writes).toHaveLength(2);
  });
  expect(writes[1]).toEqual(writes[0]);
  expect(deliveries.size).toBe(1);
});
