import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

// Each page loads its lazy route on first render; under a busy machine that
// can outlast the default one-second wait without anything being wrong.

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const secretVersionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const base = `http://pertexo.test/v1/workspaces/${workspaceId}/connections`;
const user = {
  id: userId,
  email: 'owner@example.test',
  displayName: 'Workspace Owner',
  status: 'active',
  revision: 1,
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};
const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  revision: 1,
  role: 'owner',
  capabilities: [
    'workspace:read',
    'workflow:read',
    'connection:read',
    'connection:use',
    'connection:manage',
  ],
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

type Provider = 'slack' | 'http' | 'email';
const authTypes = {
  slack: 'slack_bot_token',
  http: 'http_headers',
  email: 'resend_api_key',
} as const;

function connection(
  name: string,
  overrides: Readonly<Record<string, unknown>> & {
    providerKey?: Provider;
  } = {},
) {
  const providerKey = overrides.providerKey ?? 'slack';
  return {
    id: connectionId,
    workspaceId,
    providerKey,
    name,
    authType: authTypes[providerKey],
    status: 'active',
    secretVersionId,
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
    ...overrides,
  };
}

function identityHandlers(currentWorkspace: unknown = workspace) {
  return [
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
  ];
}

function listOf(items: () => readonly unknown[]) {
  return http.get(base, () =>
    HttpResponse.json({ items: items(), nextCursor: null }),
  );
}

function detailOf(current: () => ReturnType<typeof connection>) {
  return http.get(`${base}/${connectionId}`, () =>
    HttpResponse.json(current()),
  );
}

function testedOk(current: ReturnType<typeof connection>) {
  return HttpResponse.json({
    connection: current,
    outcome: { ok: true, httpStatus: 200, errorCode: null },
  });
}

function mutationVariables(
  queryClient: ReturnType<typeof renderApp>['queryClient'],
) {
  return JSON.stringify(
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables),
  );
}

function lens() {
  const sheet = document.querySelector<HTMLElement>(
    '[data-slot="sheet-content"]',
  );
  if (sheet === null) throw new Error('No lens is open.');
  return within(sheet);
}

describe('connections page', () => {
  it('keeps data through a failed refresh and hides it after a nondisclosing 404', async () => {
    let response: 'ok' | 'failed' | 'unavailable' = 'ok';
    mockServer.use(
      ...identityHandlers(),
      http.get(base, () => {
        if (response === 'failed') return HttpResponse.error();
        if (response === 'unavailable')
          return HttpResponse.json(
            {
              type: 'urn:pertexo:problem:resource.not_found',
              title: 'Resource not found',
              status: 404,
              code: 'resource.not_found',
              requestId: 'request-connections-not-found',
            },
            {
              status: 404,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        return HttpResponse.json({
          items: [connection('Primary Slack')],
          nextCursor: null,
        });
      }),
    );
    const { queryClient } = renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();
    expect(screen.getByText('Active')).toBeVisible();
    expect(screen.getByText('never tested')).toBeVisible();

    response = 'failed';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Couldn’t refresh. Showing results from/u,
    );
    expect(screen.getByText('Primary Slack')).toBeVisible();

    response = 'ok';
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    response = 'unavailable';
    await queryClient.refetchQueries({
      queryKey: ['identity', userId, 'workspace', workspaceId, 'connections'],
    });
    expect(
      await screen.findByRole('heading', {
        name: 'Connections are unavailable',
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Add connection' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Primary Slack')).not.toBeInTheDocument();
  });

  it('paginates safe connection metadata and shows health in words', async () => {
    mockServer.use(
      ...identityHandlers(),
      http.get(base, ({ request }) =>
        HttpResponse.json(
          new URL(request.url).searchParams.get('after') === null
            ? {
                items: [
                  connection('Primary Slack', {
                    status: 'reauthorization_required',
                    health: {
                      lastTestedAt: '2026-09-15T11:00:00.000Z',
                      lastHealthyAt: null,
                      lastErrorCode: 'connection.credential_rejected',
                    },
                  }),
                ],
                nextCursor: 'next',
              }
            : {
                items: [
                  connection('Incident Slack', {
                    id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
                  }),
                ],
                nextCursor: null,
              },
        ),
      ),
    );

    renderApp(`/w/${workspaceId}/connections`);
    expect(await screen.findByText('Primary Slack')).toBeVisible();
    expect(screen.getByText('last test failed · invalid token')).toBeVisible();
    expect(screen.getByText('1 needs reconnecting')).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Incident Slack')).toBeVisible();
    expect(screen.queryByText(/xoxb-/u)).not.toBeInTheDocument();
    expect(screen.queryByText(connectionId)).not.toBeInTheDocument();
  });

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
            schemaVersion: 1,
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
      screen.getByRole('button', { name: /Operations Slack, Active/u }),
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
    expect(lens().getByRole('button', { name: 'Save anyway' })).toBeVisible();
    expect(bodies).toEqual([
      {
        providerKey: 'http',
        name: 'Billing API',
        credential: {
          schemaVersion: 1,
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
        schemaVersion: 1,
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
      await screen.findByRole('button', { name: /Operations Slack, Active/u }),
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
        schemaVersion: 1,
        type: 'slack_bot_token',
        botToken: nextToken,
      },
    });
    expect(mutationVariables(queryClient)).not.toContain(nextToken);
  });

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
