import { createUserFixture } from '../support/fixtures/identity';
import { HttpResponse, http } from 'msw';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const user = createUserFixture({
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
});

function problem(
  status: number,
  code: string,
  headers: Record<string, string> = {},
) {
  return HttpResponse.json(
    {
      type: `https://pertexo.test/problems/${code}`,
      title: code,
      status,
      code,
      requestId: `request-${code}`,
    },
    {
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
    },
  );
}

function workspacesFail(response: () => Response) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', response),
  );
}

describe('a page that fails to load says what went wrong', () => {
  it('waits out a rate limit before offering to try again', async () => {
    workspacesFail(() =>
      problem(429, 'rate_limit.exceeded', { 'retry-after': '30' }),
    );
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', { name: 'Too many requests' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Try again in/u }),
    ).toBeDisabled();
    expect(screen.queryByText('Something broke on our side')).toBeNull();
  });

  it('tells people offline to check their connection', async () => {
    workspacesFail(() => HttpResponse.error());
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', { name: 'Pertexo can’t be reached' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  it('explains a refused page instead of blaming the server', async () => {
    workspacesFail(() => problem(403, 'workspace.forbidden'));
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', {
        name: 'You don’t have access to this',
      }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Pertexo' })).toBeVisible();
  });

  it('keeps the error ID for a real server failure', async () => {
    workspacesFail(() => problem(500, 'internal.unexpected'));
    renderApp('/workspaces');

    expect(
      await screen.findByRole('heading', {
        name: 'Something broke on our side',
      }),
    ).toBeVisible();
    expect(screen.getByText('request-internal.unexpected')).toBeVisible();
  });
});
