import { screen, waitFor, within } from '@testing-library/react';

import userEvent, { type UserEvent } from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import {
  identityHandlers,
  lifecycleChange,
  problem,
  user,
  workspace,
  workspaceId,
} from './fixture';

const suspended = { ...workspace, status: 'suspended' } as const;
const reactivateUrl = `http://pertexo.test/v1/workspaces/${workspaceId}/reactivate`;
const suspendedBanner = /This workspace is suspended\./u;
const button = { name: 'Reactivate workspace' };

/** The workspace list follows the commands the server has accepted. */
function suspendedUntilReactivated() {
  const server = { accepted: false };
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({
        items: [
          { ...workspace, status: server.accepted ? 'active' : 'suspended' },
        ],
        nextCursor: null,
      }),
    ),
  );
  return server;
}

/** Whether Reactivate asks for a confirmation first is the design's choice. */
async function pressReactivate(actor: UserEvent) {
  const [first] = await screen.findAllByRole('button', button);
  if (first === undefined) throw new Error('No Reactivate workspace button');
  await actor.click(first);
  const confirmation = screen.queryByRole('dialog');
  if (confirmation !== null)
    await actor.click(within(confirmation).getByRole('button', button));
}

describe('reactivating a workspace', () => {
  // audit-1030 follow-up 1: nothing can lift a restore's `suspended` today.
  it.fails('lifts the suspension for someone who may manage it', async () => {
    const server = suspendedUntilReactivated();
    const keys: (string | null)[] = [];
    mockServer.use(
      http.post(reactivateUrl, ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        server.accepted = true;
        return HttpResponse.json(lifecycleChange('reactivated'));
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    expect(await screen.findByText(suspendedBanner)).toBeVisible();

    await pressReactivate(userEvent.setup());

    await waitFor(() => {
      expect(screen.queryByText(suspendedBanner)).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('button', button)).not.toBeInTheDocument();
    expect(keys).toEqual([expect.any(String)]);
  });

  // audit-1030 follow-up 1: a new key would be refused once the first landed.
  it.fails(
    'retries an unconfirmed reactivation with its first key',
    async () => {
      const server = suspendedUntilReactivated();
      const keys: (string | null)[] = [];
      mockServer.use(
        http.post(reactivateUrl, ({ request }) => {
          keys.push(request.headers.get('idempotency-key'));
          if (keys.length === 1) return HttpResponse.error();
          server.accepted = true;
          return HttpResponse.json(lifecycleChange('reactivated'));
        }),
      );
      renderApp(`/w/${workspaceId}/settings`, { strict: true });
      const actor = userEvent.setup();

      await pressReactivate(actor);
      await actor.click(
        await screen.findByRole('button', { name: 'Try again' }),
      );

      await waitFor(() => {
        expect(screen.queryByText(suspendedBanner)).not.toBeInTheDocument();
      });
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    },
  );

  // audit-1030 follow-up 1: another tab may have moved the workspace on.
  it.fails('says so when the workspace changed meanwhile', async () => {
    mockServer.use(
      ...identityHandlers(suspended),
      http.post(reactivateUrl, () =>
        problem(409, 'workspace.conflict', 'Workspace conflict'),
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);

    await pressReactivate(userEvent.setup());

    expect(
      await screen.findByText(/The workspace changed meanwhile/u),
    ).toBeVisible();
  });

  it.each([
    ['may not manage it', { ...suspended, capabilities: ['workspace:read'] }],
    ['manages an active workspace', workspace],
    [
      'manages a workspace scheduled for deletion',
      { ...workspace, status: 'pending_deletion' },
    ],
  ])('offers no button to someone who %s', async (_who, current) => {
    mockServer.use(...identityHandlers(current));
    renderApp(`/w/${workspaceId}/settings`);

    expect(
      await screen.findByRole('heading', { name: 'Workspace' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('button', { name: /^Copy workspace ID / }),
    ).toBeVisible();
    expect(screen.queryByRole('button', button)).not.toBeInTheDocument();
  });
});
