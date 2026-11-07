import { NotificationsProvider } from '@/components/ui/toast';
import { federationSettingsQueryOptions } from '@/features/federation/data/settings.queries';
import { ProviderForm } from '@/features/federation/components/providers/form';
import { createApiClient } from '@/lib/api/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
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
it.each(['oidc', 'saml'] as const)(
  'keeps %s edits through a failed current-settings read and an explicit retry',
  async (kind) => {
    const { fetch, scope, cache } = fixture();
    const provider = kind === 'saml' ? samlProvider : organization.providers[0];
    if (provider === undefined) throw new Error('Missing provider');
    let current = {
      ...settings,
      organization: { ...organization, providers: [provider] },
    };
    const bodies: unknown[] = [];
    let failedReads = 0;
    fetch.mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        bodies.push((await new Response(init.body).json()) as unknown);
        if (bodies.length === 1) {
          current = {
            ...current,
            organization: { ...current.organization, revision: 2 },
          };
          return new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Organization changed',
              status: 409,
              code: 'workspace.conflict',
              requestId: 'provider-conflict',
            }),
            {
              status: 409,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
      }
      if (init?.method !== 'PUT' && bodies.length === 1 && failedReads < 2) {
        failedReads += 1;
        return new Response(
          JSON.stringify({
            type: 'about:blank',
            title: 'Unavailable',
            status: 503,
            code: 'internal.unexpected',
            requestId: 'provider-read-failed',
          }),
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }
      return json(current);
    });
    function Editor() {
      const reader = useQuery(federationSettingsQueryOptions(scope));
      const org = reader.data?.organization;
      const currentProvider = org?.providers[0];
      return org && currentProvider ? (
        <ProviderForm
          scope={scope}
          organization={org}
          provider={currentProvider}
          onClose={() => undefined}
        />
      ) : null;
    }
    render(
      <QueryClientProvider client={cache}>
        <NotificationsProvider>
          <Editor />
        </NotificationsProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Provider name');
    await user.clear(name);
    await user.type(name, 'My retained name');
    if (kind === 'oidc')
      await user.type(
        screen.getByLabelText('Client secret'),
        'retained-secret',
      );
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    expect(
      await screen.findByRole('button', {
        name: 'Keep edits and use latest revision',
      }),
    ).toBeDisabled();
    expect(await screen.findByText('provider-read-failed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Reload provider' }));
    await waitFor(() => {
      expect(failedReads).toBe(2);
      expect(
        screen.getByRole('button', { name: 'Reload provider' }),
      ).toBeEnabled();
    });
    expect(name).toHaveValue('My retained name');
    if (kind === 'oidc')
      expect(screen.getByLabelText('Client secret')).toHaveValue(
        'retained-secret',
      );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', {
          name: 'Keep edits and use latest revision',
        }),
      ).toBeEnabled();
    });
    await user.click(
      await screen.findByText('Review current provider settings'),
    );
    expect(
      screen.getByRole('region', { name: 'Current saved provider settings' }),
    ).toHaveTextContent(provider.name);
    await user.click(
      await screen.findByRole('button', {
        name: 'Keep edits and use latest revision',
      }),
    );
    expect(name).toHaveValue('My retained name');
    if (kind === 'oidc')
      expect(screen.getByLabelText('Client secret')).toHaveValue(
        'retained-secret',
      );
    await user.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toMatchObject({
      name: 'My retained name',
      expectedRevision: 2,
    });
  },
);
