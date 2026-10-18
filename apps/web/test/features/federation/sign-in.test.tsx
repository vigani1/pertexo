import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationSignInForm } from '@/features/federation/components/sign-in';
import { createApiClient } from '@/lib/api/client';
import { providerId, json } from './fixtures';
function fixture() {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const apiClient = createApiClient({ fetch, readCsrfToken: () => undefined });
  const navigateToProvider = vi.fn();
  render(
    <OrganizationSignInForm
      apiClient={apiClient}
      returnTo="/account/security"
      navigateToProvider={navigateToProvider}
    />,
  );
  return { fetch, navigateToProvider };
}
describe('organization sign-in form', () => {
  it('validates an exact domain before contacting the API', async () => {
    const { fetch } = fixture();
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Organization domain'),
      'https://example.test',
    );
    await user.click(screen.getByRole('button', { name: 'Find sign-in' }));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Organization domain')).toHaveFocus();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Enter your organization domain',
    );
  });
  it('explains an unconfigured domain and never pretends the role changed', async () => {
    const { fetch, navigateToProvider } = fixture();
    fetch.mockResolvedValueOnce(json({ required: false, providers: [] }));
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Organization domain'),
      'example.test',
    );
    await user.click(screen.getByRole('button', { name: 'Find sign-in' }));
    expect(
      await screen.findByText(/not configured for this domain/u),
    ).toBeVisible();
    expect(navigateToProvider).not.toHaveBeenCalled();
  });
  it.each(['oidc', 'saml'] as const)(
    'uses the discovered %s provider and normalized domain with the original safe return path',
    async (protocol) => {
      const { fetch, navigateToProvider } = fixture();
      fetch
        .mockResolvedValueOnce(
          json({
            required: true,
            providers: [{ id: providerId, name: 'Work SSO', kind: protocol }],
          }),
        )
        .mockResolvedValueOnce(
          json({
            authorizationUrl: 'https://idp.example.test/authorize?state=opaque',
          }),
        );
      const user = userEvent.setup();
      await user.type(
        screen.getByLabelText('Organization domain'),
        'EXAMPLE.TEST',
      );
      await user.click(screen.getByRole('button', { name: 'Find sign-in' }));
      await user.click(
        await screen.findByRole('button', { name: 'Continue with Work SSO' }),
      );
      await waitFor(() => {
        expect(navigateToProvider).toHaveBeenCalledWith(
          'https://idp.example.test/authorize?state=opaque',
        );
      });
      expect(fetch.mock.calls[1]?.[0]).toEqual(
        expect.stringContaining(`/v1/auth/federation/${protocol}/start`),
      );
      const body = fetch.mock.calls[1]?.[1]?.body;
      if (typeof body !== 'string') throw new Error('Missing sign-in body');
      expect(JSON.parse(body) as unknown).toEqual({
        providerId,
        domain: 'example.test',
        returnPath: '/account/security',
      });
    },
  );
  it('rejects an unsafe authorization URL instead of navigating', async () => {
    const { fetch, navigateToProvider } = fixture();
    fetch
      .mockResolvedValueOnce(
        json({
          required: false,
          providers: [{ id: providerId, name: 'Work SSO', kind: 'oidc' }],
        }),
      )
      .mockResolvedValueOnce(json({ authorizationUrl: 'javascript:alert(1)' }));
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText('Organization domain'),
      'example.test',
    );
    await user.click(screen.getByRole('button', { name: 'Find sign-in' }));
    await user.click(
      await screen.findByRole('button', { name: 'Continue with Work SSO' }),
    );
    expect(await screen.findByText(/could not start/u)).toBeVisible();
    expect(navigateToProvider).not.toHaveBeenCalled();
  });
});
