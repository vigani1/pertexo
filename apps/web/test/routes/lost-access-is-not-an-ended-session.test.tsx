import { HttpResponse, http } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderLoadedApp } from '../support/render-app';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../support/fixtures/identity';

const owner = createUserFixture({ email: 'owner@example.test' });
const workspace = createWorkspaceFixture({
  capabilities: ['workspace:read', 'variable:manage'],
});
const variables = `http://pertexo.test/v1/workspaces/${workspace.id}/variables`;
const path = `/w/${workspace.id}/settings/variables`;

function problem(status: number, code: string) {
  return HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Refused',
      status,
      code,
      requestId: 'lost-access',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

type Refusal = Readonly<{ status: number; code: string; member: boolean }>;

/** A variables page whose access can be taken away while it is open. */
function server() {
  const state = { refusal: undefined as Refusal | undefined };
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(owner)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: state.refusal?.member === false ? [] : [workspace],
        nextCursor: null,
      }),
    ),
    http.get(variables, () =>
      state.refusal === undefined
        ? HttpResponse.json({
            revision: 1,
            values: { RATE: 10 },
            descriptions: { RATE: 'Rate applied to invoices.' },
          })
        : problem(state.refusal.status, state.refusal.code),
    ),
  );
  return state;
}

/** The session is fine: nothing on screen may treat this as signing out. */
function expectNoSessionPause() {
  expect(
    screen.queryByRole('heading', { name: 'Your session ended' }),
  ).toBeNull();
  expect(screen.queryByRole('link', { name: /Sign in again/u })).toBeNull();
  expect(screen.queryByText(/sign in again/iu)).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Discard changes and sign in here' }),
  ).toBeNull();
}

afterEach(() => {
  localStorage.clear();
});

describe('losing access to a page is not an ended session', () => {
  it.each([
    [
      'a refused read',
      { status: 403, code: 'workspace.forbidden', member: true },
    ],
    [
      'a read that finds nothing',
      { status: 404, code: 'resource.not_found', member: true },
    ],
    [
      'removal from the workspace',
      { status: 403, code: 'workspace.forbidden', member: false },
    ],
  ] as const)(
    'hides the data after %s and offers no sign-in',
    async (_name, refusal) => {
      const state = server();
      const app = await renderLoadedApp(path);
      const row = await screen.findByRole('region', { name: 'RATE' });
      expect(within(row).getByText('Rate applied to invoices.')).toBeVisible();

      state.refusal = refusal;
      await act(() =>
        app.queryClient.refetchQueries({
          predicate: (query) => query.queryKey.includes('variables'),
        }),
      );
      if (!refusal.member) await act(() => app.queryClient.refetchQueries());

      await waitFor(() => {
        expect(screen.queryByRole('region', { name: 'RATE' })).toBeNull();
      });
      expect(screen.queryByText('Rate applied to invoices.')).toBeNull();
      expectNoSessionPause();
    },
  );
});
