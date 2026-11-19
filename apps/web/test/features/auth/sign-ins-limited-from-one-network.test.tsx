import { HttpResponse, http } from 'msw';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { LoginPage } from '@/features/auth/pages/login';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp, testFetch } from '../../support/render-app';
import { renderInRouter } from '../../support/render-in-router';
import { passwordCapabilities, problem } from './workspace-entry/fixture';

const providerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The answer when everyone at one office address has spent the shared budget. */
function limited(seconds: number) {
  const refused = problem(
    429,
    'request.rate_limited',
    'Too many authentication requests',
  );
  refused.headers.set('retry-after', String(seconds));
  return refused;
}

function apiClient() {
  return createApiClient({ fetch: testFetch, readCsrfToken: () => undefined });
}

async function findOrganizationSignIn(domain: string) {
  const actor = userEvent.setup();
  await actor.click(
    await screen.findByRole('button', { name: 'Organization sign-in' }),
  );
  await actor.type(screen.getByLabelText('Organization domain'), domain);
  await actor.click(screen.getByRole('button', { name: 'Find sign-in' }));
  return actor;
}

describe('sign-ins refused because one network used its shared budget', () => {
  it('says the network is busy, not that sign-in is unavailable, when the page’s read is refused', async () => {
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/capabilities', () => limited(42)),
    );
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    expect(
      await screen.findByText(
        'Too many sign-ins from this network right now. Try again in 42 s.',
        {},
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(screen.queryByText(/isn’t available/u)).toBeNull();
  });

  it('says the network is busy when finding the organization’s sign-in is refused', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/auth/federation/discover', () =>
        limited(17),
      ),
    );
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    await findOrganizationSignIn('example.test');
    expect(
      await screen.findByText(
        'Too many sign-ins from this network right now. Try again in 17 s.',
      ),
    ).toBeVisible();
  });

  it('says the network is busy when starting organization sign-in is refused', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/auth/federation/discover', () =>
        HttpResponse.json({
          required: false,
          providers: [{ id: providerId, name: 'Work SSO', kind: 'oidc' }],
        }),
      ),
      http.post('http://pertexo.test/v1/auth/federation/oidc/start', () =>
        limited(9),
      ),
    );
    renderInRouter(<LoginPage apiClient={apiClient()} />);
    const actor = await findOrganizationSignIn('example.test');
    await actor.click(
      await screen.findByRole('button', { name: 'Continue with Work SSO' }),
    );
    expect(
      await screen.findByText(
        'Too many sign-ins from this network right now. Try again in 9 s.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(/could not start/u)).toBeNull();
  });

  it('says the network is busy when a provider’s callback was refused', async () => {
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        problem(401, 'auth.unauthenticated', 'Authentication required'),
      ),
    );
    await renderLoadedApp('/login?error=sign_in_limited');
    expect(
      await screen.findByText(
        'Too many sign-ins from this network right now. Try again in a minute.',
      ),
    ).toBeVisible();
  });
});
