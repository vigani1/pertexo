import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  api,
  ownerWorkspace,
  problem,
  user,
  workspace,
  workspaceId,
} from '../support/team-fixtures';

const builderWorkspace = {
  ...workspace,
  role: 'builder',
  capabilities: ['workspace:read'],
};
const capabilities = http.get('http://pertexo.test/v1/auth/capabilities', () =>
  HttpResponse.json({
    password: { enabled: true, minimumLength: 12, verificationRequired: true },
    socialProviders: [],
  }),
);

/** Identity reads that end, like the session, once the person has left. */
function identityUntilLeft(current: unknown, left: () => boolean) {
  return [
    capabilities,
    http.get('http://pertexo.test/v1/users/me', () =>
      left() ? problem(401, 'auth.unauthenticated') : HttpResponse.json(user),
    ),
    http.get('http://pertexo.test/v1/workspaces', () =>
      left()
        ? problem(401, 'auth.unauthenticated')
        : HttpResponse.json({ items: [current], nextCursor: null }),
    ),
  ];
}

type Leave = Readonly<{ key: string | null; body: unknown }>;

function leaveHandler(sent: Leave[], answer: (attempt: number) => Response) {
  return http.post(`${api}/leave`, async ({ request }) => {
    sent.push({
      key: request.headers.get('idempotency-key'),
      body: await request.json(),
    });
    return answer(sent.length);
  });
}

async function openLeave(actor: ReturnType<typeof userEvent.setup>) {
  await actor.click(
    await screen.findByRole('button', { name: 'Leave workspace' }),
  );
  return within(await screen.findByRole('dialog'));
}

describe('settings: leaving a workspace', () => {
  it('says what leaving does, leaves once and returns through sign-in', async () => {
    const sent: Leave[] = [];
    mockServer.use(
      ...identityUntilLeft(builderWorkspace, () => sent.length > 0),
      leaveHandler(sent, () =>
        HttpResponse.json({
          userId: user.id,
          roleRevision: 2,
          replayed: false,
        }),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/settings`, { strict: true });

    const dialog = await openLeave(actor);
    expect(
      dialog.getByRole('heading', { name: `Leave ${workspace.name}?` }),
    ).toBeVisible();
    expect(
      dialog.getByText(/signed out everywhere, including here/u),
    ).toBeVisible();
    expect(
      dialog.getByText(/invitations you sent stay pending/u),
    ).toBeVisible();
    await actor.click(dialog.getByRole('button', { name: 'Leave workspace' }));

    expect(await screen.findByText(`You left ${workspace.name}`)).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(sent).toEqual([{ key: expect.any(String) as unknown, body: {} }]);
  });

  it('keeps an unconfirmed leave for an exact retry and treats an ended session as left', async () => {
    const sent: Leave[] = [];
    mockServer.use(
      ...identityUntilLeft(builderWorkspace, () => sent.length > 1),
      leaveHandler(sent, (attempt) =>
        attempt === 1
          ? HttpResponse.error()
          : problem(401, 'auth.unauthenticated'),
      ),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/settings`);

    const dialog = await openLeave(actor);
    await actor.click(dialog.getByRole('button', { name: 'Leave workspace' }));
    expect(
      await dialog.findByText(/couldn’t confirm whether you left/u),
    ).toBeVisible();
    await actor.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await actor.click(dialog.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
  });

  it('tells the owner to hand the workspace over before leaving', async () => {
    mockServer.use(
      ...identityUntilLeft(
        {
          ...ownerWorkspace,
          capabilities: [...ownerWorkspace.capabilities, 'workspace:manage'],
        },
        () => false,
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);

    expect(
      await screen.findByText(/You’re the owner, so you can’t leave yet/u),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Team' })).toHaveAttribute(
      'href',
      `/w/${workspaceId}/team`,
    );
    expect(
      screen.queryByRole('button', { name: 'Leave workspace' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete workspace' }),
    ).toBeVisible();
  });

  it('explains a refused leave without leaving', async () => {
    const sent: Leave[] = [];
    mockServer.use(
      ...identityUntilLeft(builderWorkspace, () => false),
      leaveHandler(sent, () => problem(403, 'auth.forbidden')),
    );
    const actor = userEvent.setup();
    renderApp(`/w/${workspaceId}/settings`);

    const dialog = await openLeave(actor);
    await actor.click(dialog.getByRole('button', { name: 'Leave workspace' }));
    expect(await dialog.findByText(/The owner can’t leave/u)).toBeVisible();
    expect(sent).toHaveLength(1);
  });
});
