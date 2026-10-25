import { screen } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { expectSignInPage, renderApp } from '../../../support/render-app';

import { passwordCapabilities, problem, user } from './fixture';

describe('authentication and workspace entry', () => {
  it('runs the loader-free logout route once in StrictMode and preserves caches for a deliberate retry', async () => {
    let logoutRequests = 0;
    let workspaceReads = 0;
    let signedOut = false;
    mockServer.use(
      passwordCapabilities,
      http.get('http://pertexo.test/v1/users/me', () =>
        signedOut
          ? problem(401, 'auth.unauthenticated', 'Authentication required')
          : HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () => {
        workspaceReads += 1;
        return problem(
          503,
          'service.unavailable',
          'Workspace service unavailable',
        );
      }),
      http.post('http://pertexo.test/v1/auth/logout', () => {
        logoutRequests += 1;
        if (logoutRequests === 1)
          return problem(503, 'service.unavailable', 'Logout unavailable');
        signedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const app = renderApp('/logout', { strict: true });
    app.queryClient.setQueryData(['protected', 'sentinel'], 'preserved');

    expect(
      await screen.findByRole('heading', {
        name: 'Sign-out didn’t finish',
      }),
    ).toBeVisible();
    expect(logoutRequests).toBe(1);
    expect(workspaceReads).toBe(0);
    expect(app.queryClient.getQueryData(['protected', 'sentinel'])).toBe(
      'preserved',
    );

    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    await expectSignInPage();
    expect(logoutRequests).toBe(2);
    expect(workspaceReads).toBe(0);
    expect(
      app.queryClient.getQueryData(['protected', 'sentinel']),
    ).toBeUndefined();
  });
});
