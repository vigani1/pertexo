import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  base,
  connection,
  identityHandlers,
  lens,
  listOf,
  workspaceId,
} from './page/fixture';

/** What docs/guides/oauth2-connections.md promises each choice fills in. */
const GOOGLE = {
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scope: 'https://www.googleapis.com/auth/userinfo.email',
  authorizationParameters: { access_type: 'offline', prompt: 'consent' },
  hosts: ['*.googleapis.com'],
};
const MICROSOFT = {
  authorizationUrl:
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  scope: 'offline_access https://graph.microsoft.com/User.Read',
  authorizationParameters: {},
  hosts: ['graph.microsoft.com'],
};

type CreateBody = Readonly<{
  name: string;
  credential: Readonly<{
    type: string;
    clientSecret: string;
    settings: Readonly<Record<string, unknown>>;
  }>;
}>;

describe('choosing a service for an OAuth2 connection', () => {
  let createBody: CreateBody | undefined;

  beforeEach(() => {
    createBody = undefined;
    mockServer.use(
      ...identityHandlers(),
      listOf(() => []),
      http.post(base, async ({ request }) => {
        createBody = (await request.json()) as CreateBody;
        return HttpResponse.json(
          connection(createBody.name, {
            providerKey: 'http',
            authType: 'oauth2',
            status: 'reauthorization_required',
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: 'connection.oauth2_not_authorized',
            },
            oauth2: {
              settings: createBody.credential.settings,
              redirectUri: 'http://pertexo.test/v1/connections/oauth2/callback',
            },
          }),
          { status: 201 },
        );
      }),
    );
  });

  const openForm = async () => {
    renderApp(`/w/${workspaceId}/connections?add=http`);
    const event = userEvent.setup();
    await event.click(await screen.findByRole('radio', { name: 'OAuth2' }));
    return event;
  };
  type Event = Awaited<ReturnType<typeof openForm>>;

  const choose = (event: Event, service: string) =>
    event.click(lens().getByRole('radio', { name: service }));

  const value = (label: string) =>
    (lens().getByLabelText(label) as HTMLInputElement).value;

  const replace = async (event: Event, label: string, text: string) => {
    const field = lens().getByLabelText(label);
    await event.clear(field);
    await event.type(field, text);
  };

  const openAdvanced = (event: Event) =>
    event.click(lens().getByText('Advanced'));

  const typeClient = async (event: Event) => {
    await event.type(lens().getByLabelText('Client ID'), 'my-client');
    await event.type(lens().getByLabelText('Client secret'), 'my-secret');
  };

  const save = async (event: Event, name = 'Calendar') => {
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    await replace(event, 'Connection name', name);
    await event.click(lens().getByRole('button', { name: 'Continue' }));
    await lens().findByRole('button', { name: 'Connect' });
    if (createBody === undefined) throw new Error('Nothing was created');
    return createBody.credential;
  };

  const serviceChosen = (service: string) =>
    expect(lens().getByRole('radio', { name: service })).toBeChecked();

  it('fills in Google, with what a refresh token needs', async () => {
    const event = await openForm();

    await choose(event, 'Google');
    await serviceChosen('Google');

    expect(value('Authorization URL')).toBe(GOOGLE.authorizationUrl);
    expect(value('Token URL')).toBe(GOOGLE.tokenUrl);
    expect(value('Scope')).toBe(GOOGLE.scope);
    await openAdvanced(event);
    expect(value('Extra authorization parameters')).toBe(
      'access_type=offline\nprompt=consent',
    );
    expect(value('Hosts')).toBe('*.googleapis.com');
    expect(lens().getByRole('radio', { name: 'Only these' })).toBeChecked();
    expect(lens().getByRole('radio', { name: 'Request body' })).toBeChecked();
    expect(lens().getByRole('checkbox', { name: 'PKCE' })).toBeChecked();
    expect(
      lens().getByText(/In Google Cloud, create an OAuth client/u),
    ).toBeVisible();
  });

  it('fills in Microsoft, asking for offline access on the common tenant', async () => {
    const event = await openForm();

    await choose(event, 'Microsoft');
    await serviceChosen('Microsoft');

    expect(value('Authorization URL')).toBe(MICROSOFT.authorizationUrl);
    expect(value('Token URL')).toBe(MICROSOFT.tokenUrl);
    expect(value('Scope')).toBe(MICROSOFT.scope);
    await openAdvanced(event);
    expect(value('Extra authorization parameters')).toBe('');
    expect(value('Hosts')).toBe('graph.microsoft.com');
    expect(lens().getByRole('radio', { name: 'Request body' })).toBeChecked();
    expect(
      lens().getByText(/replace common in both URLs with your tenant ID/u),
    ).toBeVisible();
  });

  it.each([
    {
      service: 'Google',
      expected: GOOGLE,
      signIn: 'accounts.google.com',
      token: 'oauth2.googleapis.com',
    },
    {
      service: 'Microsoft',
      expected: MICROSOFT,
      signIn: 'login.microsoftonline.com',
      token: 'login.microsoftonline.com',
    },
  ])(
    'saves $service as the settings of any other OAuth2 connection, and names the hosts',
    async ({ service, expected, signIn, token }) => {
      const event = await openForm();
      await choose(event, service);
      await typeClient(event);

      const credential = await save(event);

      expect(credential).toEqual({
        type: 'oauth2',
        clientSecret: 'my-secret',
        settings: {
          grantType: 'authorization_code',
          authorizationUrl: expected.authorizationUrl,
          authorizationParameters: expected.authorizationParameters,
          pkce: 's256',
          tokenUrl: expected.tokenUrl,
          clientId: 'my-client',
          scope: expected.scope,
          clientAuthentication: 'body',
          tokenParameters: {},
          requestHosts: { mode: 'listed', hosts: expected.hosts },
        },
      });
      expect(
        lens().getByText(
          new RegExp(
            `You'll sign in at ${signIn}\\. Pertexo then gets its token from ${token}\\.`,
            'u',
          ),
        ),
      ).toBeVisible();
    },
  );

  describe('nothing is locked', () => {
    it('saves a changed scope, and still reads as the service', async () => {
      const event = await openForm();
      await choose(event, 'Google');
      await typeClient(event);

      await replace(event, 'Scope', 'https://www.googleapis.com/auth/calendar');
      await serviceChosen('Google');

      const { settings } = await save(event);
      expect(settings.scope).toBe('https://www.googleapis.com/auth/calendar');
    });

    it('reads as Microsoft with a tenant ID in place of common, in both addresses', async () => {
      const tenant = 'f8cdef31-a31e-4b4a-93e4-5f571e91255a';
      const event = await openForm();
      await choose(event, 'Microsoft');
      await typeClient(event);

      await replace(
        event,
        'Authorization URL',
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      );
      await replace(
        event,
        'Token URL',
        `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      );
      await serviceChosen('Microsoft');

      const { settings } = await save(event);
      expect(settings.authorizationUrl).toContain(tenant);
      expect(settings.tokenUrl).toContain(tenant);
    });

    it('saves changed advanced settings', async () => {
      const event = await openForm();
      await choose(event, 'Google');
      await typeClient(event);
      await openAdvanced(event);

      await event.click(lens().getByRole('checkbox', { name: 'PKCE' }));
      await event.click(lens().getByRole('radio', { name: 'Basic header' }));
      await replace(event, 'Hosts', 'sheets.googleapis.com');
      await replace(event, 'Extra authorization parameters', 'login_hint=me');

      const { settings } = await save(event);
      expect(settings).toMatchObject({
        pkce: 'none',
        clientAuthentication: 'basic',
        requestHosts: { mode: 'listed', hosts: ['sheets.googleapis.com'] },
        authorizationParameters: { login_hint: 'me' },
      });
    });

    it('lets Server to server replace the sign-in the service came with', async () => {
      const event = await openForm();
      await choose(event, 'Microsoft');
      await typeClient(event);

      await event.click(
        lens().getByRole('radio', { name: 'Server to server' }),
      );
      expect(lens().queryByLabelText('Authorization URL')).toBeNull();
      await serviceChosen('Microsoft');

      const { settings } = await save(event);
      expect(settings.grantType).toBe('client_credentials');
      expect(settings).not.toHaveProperty('authorizationUrl');
      expect(settings.tokenUrl).toBe(MICROSOFT.tokenUrl);
    });
  });

  describe('changing your mind', () => {
    it('keeps the client ID and secret you typed, and nothing else of the last service', async () => {
      const event = await openForm();
      await choose(event, 'Google');
      await typeClient(event);

      await choose(event, 'Microsoft');

      expect(value('Client ID')).toBe('my-client');
      expect(value('Client secret')).toBe('my-secret');
      const { settings } = await save(event);
      expect(settings).toMatchObject({
        authorizationUrl: MICROSOFT.authorizationUrl,
        authorizationParameters: {},
        scope: MICROSOFT.scope,
        requestHosts: { mode: 'listed', hosts: MICROSOFT.hosts },
      });
    });

    it('empties what the service filled in when you go to Other service', async () => {
      const event = await openForm();
      await choose(event, 'Google');
      await typeClient(event);

      await choose(event, 'Other service');
      await serviceChosen('Other service');

      expect(value('Authorization URL')).toBe('');
      expect(value('Token URL')).toBe('');
      expect(value('Scope')).toBe('');
      expect(value('Client ID')).toBe('my-client');
      expect(value('Client secret')).toBe('my-secret');
      expect(
        lens().getByText('Register this address with the service first.'),
      ).toBeVisible();
      expect(lens().queryByText(/In Google Cloud/u)).toBeNull();
      await openAdvanced(event);
      expect(value('Extra authorization parameters')).toBe('');
      expect(lens().getByRole('radio', { name: 'Any host' })).toBeChecked();
      expect(lens().getByRole('radio', { name: 'Basic header' })).toBeChecked();
      expect(lens().queryByLabelText('Hosts')).toBeNull();
    });

    // Parameters a person typed for one service mean nothing to the next, and they're
    // out of sight under Advanced by then, on their way to its token address.
    it('doesn’t carry extra token parameters over to the service you choose', async () => {
      const event = await openForm();
      await openAdvanced(event);
      await event.type(
        lens().getByLabelText('Extra token parameters'),
        'audience=https://api.example.test',
      );
      await typeClient(event);

      await choose(event, 'Google');

      expect(value('Extra token parameters')).toBe('');
      const { settings } = await save(event);
      expect(settings.tokenParameters).toEqual({});
    });

    it('takes Google back to signing in with consent after Server to server', async () => {
      const event = await openForm();
      await event.click(
        lens().getByRole('radio', { name: 'Server to server' }),
      );

      await choose(event, 'Google');

      expect(
        lens().getByRole('radio', { name: 'Sign in with consent' }),
      ).toBeChecked();
      expect(value('Authorization URL')).toBe(GOOGLE.authorizationUrl);
    });
  });

  it('shows the redirect URL to register, whichever service is chosen', async () => {
    const event = await openForm();
    for (const service of ['Google', 'Microsoft', 'Other service']) {
      await choose(event, service);
      expect(value('Redirect URL')).toMatch(
        /\/v1\/connections\/oauth2\/callback$/u,
      );
      expect(
        lens().getByRole('button', { name: 'Copy redirect URL' }),
      ).toBeVisible();
    }
  });
});
