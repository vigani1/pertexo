import { ProviderForm } from '@/features/federation/components/providers/form';
import { createApiClient } from '@/lib/api/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { readRequestJson } from '../../support/request';
import { json, organization, settings, userId, workspaceId } from './fixtures';
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const apiClient = createApiClient({
    fetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  return {
    fetch,
    scope: { apiClient, userId, workspaceId },
    cache: new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    }),
  };
}
describe('private organization provider editing', () => {
  it('retains the exact secret request after a lost response without placing secrets in either query cache', async () => {
    const { fetch, scope, cache } = fixture();
    fetch
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockResolvedValueOnce(json(settings));
    const onClose = vi.fn();
    render(
      <QueryClientProvider client={cache}>
        <ProviderForm
          scope={scope}
          organization={organization}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Provider name'), 'Work sign-in');
    await user.type(
      screen.getByLabelText('OIDC issuer'),
      'https://idp.example.test',
    );
    await user.type(screen.getByLabelText('Client ID'), 'new-client');
    const secret = 'test-only-private-provider-material';
    await user.type(screen.getByLabelText('Client secret'), secret);
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    await screen.findByRole('button', { name: 'Retry same request' });
    expect(screen.getByLabelText('Client secret')).toBeDisabled();
    expect(cache.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(cache.getQueryCache().getAll())).not.toContain(
      secret,
    );
    await user.click(
      screen.getByRole('button', { name: 'Retry same request' }),
    );
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0]?.[1],
      second = fetch.mock.calls[1]?.[1];
    expect(first?.body).toBe(second?.body);
    expect(new Headers(first?.headers).get('Idempotency-Key')).toBe(
      new Headers(second?.headers).get('Idempotency-Key'),
    );
    expect(cache.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(cache.getQueryCache().getAll())).not.toContain(
      secret,
    );
  });
  it('keeps edits across background refetches and requires explicit reload before saving a stale provider', async () => {
    const { fetch, scope, cache } = fixture();
    const provider = organization.providers[0];
    if (provider === undefined) throw new Error('Missing provider');
    const onClose = vi.fn();
    const view = render(
      <QueryClientProvider client={cache}>
        <ProviderForm
          scope={scope}
          organization={organization}
          provider={provider}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Provider name'));
    await user.type(screen.getByLabelText('Provider name'), 'My unsaved name');
    await user.type(screen.getByLabelText('Client secret'), 'unsaved-secret');
    const changed = {
      ...organization,
      revision: 2,
      providers: [{ ...provider, name: 'Server name', revision: 2 }],
    };
    view.rerender(
      <QueryClientProvider client={cache}>
        <ProviderForm
          scope={scope}
          organization={changed}
          provider={{ ...provider, name: 'Server name', revision: 2 }}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText('Provider name')).toHaveValue(
      'My unsaved name',
    );
    expect(screen.getByLabelText('Client secret')).toHaveValue(
      'unsaved-secret',
    );
    expect(
      screen.getByRole('button', { name: 'Save provider' }),
    ).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reload provider' }));
    expect(screen.getByLabelText('Provider name')).toHaveValue('Server name');
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
  });
  it('keeps a removed provider in edit mode, with saving refused', () => {
    const { scope, cache } = fixture();
    const provider = organization.providers[0];
    if (provider === undefined) throw new Error('Missing provider');
    render(
      <QueryClientProvider client={cache}>
        <ProviderForm
          scope={scope}
          organization={{ ...organization, providers: [] }}
          provider={provider}
          unavailable
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.getByRole('heading', { name: 'Edit OIDC provider' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Provider name')).toHaveValue(provider.name);
    expect(
      screen.getByRole('button', { name: 'Save provider' }),
    ).toBeDisabled();
    expect(screen.getByText(/was removed in another tab/u)).toBeVisible();
  });
});

type SamlProvider = Extract<
  (typeof organization.providers)[number],
  { kind: 'saml' }
>;
const samlProvider: SamlProvider = {
  id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  kind: 'saml',
  name: 'SAML sign-in',
  issuer: 'http://www.okta.com/owned-idp',
  configuration: {
    signInUrl: 'https://idp.example.test/sso',
    certificates: ['test-only-public-certificate'],
    emailAttribute: 'email',
    nameAttribute: 'name',
    jitEnabled: false,
  },
  enabled: true,
  revision: 1,
};
describe('SAML provider editing', () => {
  it('sends public certificate configuration without OAuth credentials, with new accounts off by default', async () => {
    const { fetch, scope, cache } = fixture(),
      onClose = vi.fn();
    fetch.mockResolvedValueOnce(
      json({
        ...settings,
        organization: {
          ...organization,
          revision: 2,
          providers: [...organization.providers, samlProvider],
        },
      }),
    );
    render(
      <QueryClientProvider client={cache}>
        <ProviderForm
          kind="saml"
          scope={scope}
          organization={organization}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Provider name'), 'SAML sign-in');
    await user.type(
      screen.getByLabelText('IdP entity ID'),
      'http://www.okta.com/owned-idp',
    );
    await user.type(
      screen.getByLabelText('SSO sign-in URL'),
      'https://idp.example.test/sso',
    );
    await user.type(
      screen.getByLabelText('Signing certificate'),
      'test-only-public-certificate',
    );
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
    const body = fetch.mock.calls[0]?.[1]?.body;

    expect(
      readRequestJson({ body, missingMessage: 'Provider request missing' }),
    ).toEqual({
      kind: 'saml',
      name: 'SAML sign-in',
      issuer: 'http://www.okta.com/owned-idp',
      configuration: {
        signInUrl: 'https://idp.example.test/sso',
        certificates: ['test-only-public-certificate'],
        emailAttribute: 'email',
        nameAttribute: 'name',
        jitEnabled: false,
      },
      enabled: false,
      expectedRevision: 1,
    });
    expect(cache.getMutationCache().getAll()).toHaveLength(0);
  });
  it('preserves unsaved SAML edits across a refetch and requires explicit reload of the reviewed revision', async () => {
    const { fetch, scope, cache } = fixture();
    const original = { ...organization, providers: [samlProvider] };
    const draw = (current: typeof original) => {
      const provider = current.providers[0];
      if (provider === undefined) throw new Error('SAML provider missing');
      return (
        <QueryClientProvider client={cache}>
          <ProviderForm
            scope={scope}
            organization={current}
            provider={provider}
            onClose={vi.fn()}
          />
        </QueryClientProvider>
      );
    };
    const view = render(draw(original)),
      user = userEvent.setup();
    await user.clear(screen.getByLabelText('SSO sign-in URL'));
    await user.type(
      screen.getByLabelText('SSO sign-in URL'),
      'https://unsaved.example.test/sso',
    );
    expect(screen.getByLabelText('SSO sign-in URL')).toHaveValue(
      'https://unsaved.example.test/sso',
    );
    const changed = {
      ...original,
      revision: 2,
      providers: [
        {
          ...samlProvider,
          revision: 2,
          configuration: {
            ...samlProvider.configuration,
            certificates: ['rotated-public-certificate'],
          },
        },
      ],
    };
    view.rerender(draw(changed));
    expect(screen.getByLabelText('SSO sign-in URL')).toHaveValue(
      'https://unsaved.example.test/sso',
    );
    expect(screen.getByLabelText('Signing certificate')).toHaveValue(
      'test-only-public-certificate',
    );
    expect(
      screen.getByRole('button', { name: 'Save provider' }),
    ).toBeDisabled();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reload provider' }));
    expect(screen.getByLabelText('SSO sign-in URL')).toHaveValue(
      'https://idp.example.test/sso',
    );
    expect(screen.getByLabelText('Signing certificate')).toHaveValue(
      'rotated-public-certificate',
    );
    expect(screen.getByRole('button', { name: 'Save provider' })).toBeEnabled();
    expect(screen.getByLabelText('IdP entity ID')).toBeDisabled();
  });
});
