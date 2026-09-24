import { expect, test } from '@playwright/test';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const intentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const csrfToken = 'invitation-acceptance-csrf-token-123456';
const sessionCsrfToken = 'invitation-session-csrf-token-123456789012345678';
const token = `wi1.${workspaceId}.${intentId}.${'a'.repeat(43)}`;
const staleIntentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const staleBinding = `wb1.${workspaceId}.${staleIntentId}.${'b'.repeat(43)}.${'c'.repeat(43)}`;
const recoveredBinding = `wb1.${workspaceId}.${intentId}.${'d'.repeat(43)}.${'e'.repeat(43)}`;

test('removes the invitation token and explicitly accepts the bound journey', async ({
  page,
}) => {
  let completed = false;
  let resolvedBody: unknown;
  let resolveHeader: string | undefined;
  await page.route('**/v1/invitation-acceptance/resolve', async (route) => {
    resolvedBody = route.request().postDataJSON();
    resolveHeader = route.request().headers()['x-pertexo-invitation-request'];
    await route.fulfill({ status: 201, json: readyJourney() });
  });
  await page.route('**/v1/invitation-acceptance/complete', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      intentId,
      expectedRevision: 2,
    });
    expect(route.request().headers()['x-invitation-csrf-token']).toBe(
      csrfToken,
    );
    expect(route.request().headers()['x-csrf-token']).toBe(sessionCsrfToken);
    expect(route.request().headers()['idempotency-key']).toBeTruthy();
    completed = true;
    await route.fulfill({
      json: {
        intentId,
        workspaceId,
        role: 'builder',
        membershipCreated: true,
        replayed: false,
      },
    });
  });
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    await route.fulfill({
      json: completed
        ? {
            state: 'completed',
            intentId,
            expiresAt: '2026-09-19T19:00:00.000Z',
            csrfToken,
            workspace: { id: workspaceId, name: 'Control Operations' },
            role: 'builder',
            membershipCreated: true,
          }
        : readyJourney(),
    });
  });

  await page.context().addCookies([
    {
      name: 'pertexo_csrf',
      value: sessionCsrfToken,
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.goto(`/invitations/accept#token=${encodeURIComponent(token)}`);
  await expect(page).toHaveURL('/invitations/accept');
  await expect(
    page.getByRole('button', { name: 'Accept and open workspace' }),
  ).toBeVisible();
  expect(resolvedBody).toEqual({ token });
  expect(resolveHeader).toBe('resolve');
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    })),
  ).toEqual({ local: 0, session: 0 });

  await page.getByRole('button', { name: 'Accept and open workspace' }).click();
  await expect(
    page.getByRole('button', { name: 'Open workspace' }),
  ).toBeVisible();
  await expect(page.getByText(/joined/i)).toBeVisible();
});

test('offers reconciliation and reauthentication when completion loses its session', async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: 'pertexo_csrf',
      value: sessionCsrfToken,
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/v1/invitation-acceptance/resolve', async (route) => {
    await route.fulfill({ status: 201, json: readyJourney() });
  });
  await page.route('**/v1/invitation-acceptance/complete', async (route) => {
    expect(route.request().headers()['x-csrf-token']).toBe(sessionCsrfToken);
    expect(route.request().headers()['x-invitation-csrf-token']).toBe(
      csrfToken,
    );
    await route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      json: {
        type: 'https://pertexo.test/problems/auth.unauthenticated',
        title: 'Authentication required',
        status: 401,
        code: 'auth.unauthenticated',
        requestId: 'browser-invitation-session-loss',
      },
    });
  });
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    await route.fulfill({ json: { state: 'unavailable' } });
  });

  await page.goto(`/invitations/accept#token=${encodeURIComponent(token)}`);
  await page.getByRole('button', { name: 'Accept and open workspace' }).click();
  await expect(
    page.getByRole('button', { name: 'Check status' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign in again' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Check status' }).click();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
});

test('recovers a tokenless continuation after its initial status read fails', async ({
  page,
}) => {
  let reads = 0;
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    reads += 1;
    if (reads === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ json: { state: 'unavailable' } });
  });

  await page.goto('/invitations/accept');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  expect(reads).toBe(2);
});

test('reload recovery exposes sign-in or a completed receipt without replaying acceptance', async ({
  page,
}) => {
  let authenticated = false;
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    await route.fulfill({
      json: authenticated
        ? {
            state: 'completed',
            intentId,
            expiresAt: '2026-09-19T19:00:00.000Z',
            csrfToken,
            workspace: { id: workspaceId, name: 'Control Operations' },
            role: 'builder',
            membershipCreated: true,
          }
        : {
            state: 'sign_in_required',
            intentId,
            expiresAt: '2026-09-19T19:00:00.000Z',
            csrfToken,
          },
    });
  });
  let completionRequests = 0;
  await page.route('**/v1/invitation-acceptance/complete', async (route) => {
    completionRequests += 1;
    await route.abort();
  });

  await page.goto('/invitations/accept');
  await expect(
    page.getByRole('button', { name: 'Sign in to accept' }),
  ).toBeVisible();
  authenticated = true;
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Open workspace' }),
  ).toBeVisible();
  expect(completionRequests).toBe(0);
});

test('reopens the same email after a committed replacement loses its response and cookie', async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: 'pertexo_invitation_intent',
      value: staleBinding,
      url: 'http://127.0.0.1:4173',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  let resolveRequests = 0;
  await page.route('**/v1/invitation-acceptance/resolve', async (route) => {
    resolveRequests += 1;
    expect(route.request().headers().cookie).toContain(
      `pertexo_invitation_intent=${staleBinding}`,
    );
    if (resolveRequests === 1) {
      await route.abort('connectionfailed');
      return;
    }
    await route.fulfill({
      status: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `pertexo_invitation_intent=${recoveredBinding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`,
      },
      json: {
        state: 'sign_in_required',
        intentId,
        expiresAt: '2026-09-19T19:00:00.000Z',
        csrfToken,
      },
    });
  });
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    await route.fulfill({ json: { state: 'unavailable' } });
  });

  await page.goto(`/invitations/accept#token=${encodeURIComponent(token)}`);
  await expect(
    page.getByRole('button', { name: 'Try the link again' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign in to accept' }),
  ).toHaveCount(0);

  await page.goto(`/invitations/accept#token=${encodeURIComponent(token)}`);
  await expect(
    page.getByRole('button', { name: 'Sign in to accept' }),
  ).toBeVisible();
  expect(resolveRequests).toBe(2);
  await expect
    .poll(
      async () =>
        (await page.context().cookies()).find(
          (cookie) => cookie.name === 'pertexo_invitation_intent',
        )?.value,
    )
    .toBe(recoveredBinding);
});

test('reloads the committed journey when the replacement cookie arrives before a lost body', async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: 'pertexo_invitation_intent',
      value: staleBinding,
      url: 'http://127.0.0.1:4173',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.route('**/v1/invitation-acceptance/resolve', async (route) => {
    expect(route.request().headers().cookie).toContain(
      `pertexo_invitation_intent=${staleBinding}`,
    );
    await route.fulfill({
      status: 201,
      headers: {
        'content-type': 'application/json',
        'set-cookie': `pertexo_invitation_intent=${recoveredBinding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900`,
      },
      body: '{',
    });
  });
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    expect(route.request().headers().cookie).toContain(
      `pertexo_invitation_intent=${recoveredBinding}`,
    );
    await route.fulfill({
      json: {
        state: 'sign_in_required',
        intentId,
        expiresAt: '2026-09-19T19:00:00.000Z',
        csrfToken,
      },
    });
  });

  await page.goto(`/invitations/accept#token=${encodeURIComponent(token)}`);
  await expect(
    page.getByRole('button', { name: 'Try the link again' }),
  ).toBeVisible();
  await page.reload();

  await expect(
    page.getByRole('button', { name: 'Sign in to accept' }),
  ).toBeVisible();
});

test('keeps ordinary workspace discovery available when a replacement binding rejects cleanup', async ({
  page,
}) => {
  let cleanupRequests = 0;
  await page.route(/\/v1\/invitation-acceptance$/, async (route) => {
    if (route.request().method() === 'DELETE') {
      cleanupRequests += 1;
      await route.fulfill({
        status: 403,
        contentType: 'application/problem+json',
        json: {
          type: 'https://pertexo.test/problems/auth.forbidden',
          title: 'Forbidden',
          status: 403,
          code: 'auth.forbidden',
          requestId: 'browser-replaced-invitation-binding',
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        state: 'completed',
        intentId,
        expiresAt: '2026-09-19T19:00:00.000Z',
        csrfToken,
        workspace: { id: workspaceId, name: 'Control Operations' },
        role: 'builder',
        membershipCreated: true,
      },
    });
  });
  await page.route('**/v1/users/me', async (route) => {
    await route.fulfill({
      json: {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        email: 'builder@example.test',
        displayName: 'Pertexo Builder',
        status: 'active',
        createdAt: '2026-09-19T10:00:00.000Z',
        updatedAt: '2026-09-19T10:00:00.000Z',
      },
    });
  });
  await page.route('**/v1/workspaces?**', async (route) => {
    await route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'builder',
            capabilities: ['workspace:read', 'workflow:read'],
            createdAt: '2026-09-19T10:00:00.000Z',
            updatedAt: '2026-09-19T10:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    });
  });

  await page.goto('/invitations/accept');
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await expect(
    page.getByText(/couldn’t finish tidying up the invitation/iu),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to my workspaces' }).click();

  await expect(page).toHaveURL('/workspaces');
  expect(cleanupRequests).toBe(1);
});

function readyJourney() {
  return {
    state: 'ready',
    intentId,
    expiresAt: '2026-09-19T19:00:00.000Z',
    csrfToken,
    invitationRevision: 2,
    role: 'builder',
    sessionRotationRequired: true,
    workspace: { id: workspaceId, name: 'Control Operations' },
  } as const;
}
