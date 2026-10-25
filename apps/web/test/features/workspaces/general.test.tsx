import { screen, waitFor } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../support/mock-server';

import { expectSignInPage, renderApp } from '../../support/render-app';

import {
  problem,
  renameResponse,
  user,
  workspace,
  workspaceId,
} from './general/fixture';

describe('workspace settings', () => {
  it('renames in place and refreshes the authoritative shell in StrictMode', async () => {
    let authoritative = workspace;
    const commands: {
      body: unknown;
      csrf: string | null;
      key: string | null;
    }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            csrf: request.headers.get('x-csrf-token'),
            key: request.headers.get('idempotency-key'),
          });
          authoritative = {
            ...workspace,
            name: 'Incident Operations',
            revision: 2,
          };
          return HttpResponse.json(renameResponse(authoritative, false));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`, { strict: true });
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, '{Enter}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(commands).toHaveLength(0);
    await actor.type(input, '  Incident Operations  ');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Renamed to Incident Operations'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Rename workspace' }),
    ).toBeVisible();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.body).toEqual({
      name: 'Incident Operations',
      expectedRevision: 1,
    });
    expect(commands[0]?.csrf).toBe(
      'csrf-token-for-component-tests-12345678901234567890',
    );
    expect(commands[0]?.key).toBeTruthy();
  });
  it('preserves the exact uncertain rename command for an explicit retry', async () => {
    let authoritative = workspace;
    const commands: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          if (commands.length === 1) return HttpResponse.error();
          authoritative = { ...workspace, name: 'Recovered name', revision: 2 };
          return HttpResponse.json(renameResponse(authoritative, true));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Recovered name');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We couldn’t confirm whether the rename went through',
    );
    expect(input).toBeDisabled();
    await actor.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      (await screen.findAllByText('Recovered name')).length,
    ).toBeGreaterThan(0);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toEqual(commands[1]);
  });
  it('refreshes a revision conflict and requires explicit reapplication with a new key', async () => {
    let authoritative = workspace;
    const commands: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(
        `http://pertexo.test/v1/workspaces/${workspaceId}`,
        async ({ request }) => {
          commands.push({
            body: await request.json(),
            key: request.headers.get('idempotency-key'),
          });
          if (commands.length === 1) {
            authoritative = {
              ...workspace,
              name: 'Other tab name',
              revision: 2,
            };
            return problem(
              412,
              'workspace.revision_conflict',
              'Revision conflict',
            );
          }
          authoritative = {
            ...workspace,
            name: 'Reviewed local name',
            revision: 3,
          };
          return HttpResponse.json(renameResponse(authoritative, false));
        },
      ),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Reviewed local name');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Renamed to “Other tab name” meanwhile.',
    );
    expect(input).toHaveValue('Reviewed local name');
    await actor.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(
      (await screen.findAllByText('Reviewed local name')).length,
    ).toBeGreaterThan(0);
    expect(commands.map((command) => command.body)).toEqual([
      { name: 'Reviewed local name', expectedRevision: 1 },
      { name: 'Reviewed local name', expectedRevision: 2 },
    ]);
    expect(commands[0]?.key).not.toBe(commands[1]?.key);
  });
  it('recovers discovery after an accepted rename without issuing the command again', async () => {
    let authoritative = workspace;
    let discoveryUnavailable = false;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        discoveryUnavailable
          ? problem(503, 'service.unavailable', 'Discovery unavailable')
          : HttpResponse.json({ items: [authoritative], nextCursor: null }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        discoveryUnavailable = true;
        return HttpResponse.json(
          renameResponse(
            { ...workspace, name: 'Durable rename', revision: 2 },
            false,
          ),
        );
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Durable rename');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The new name is saved, but this page couldn’t catch up',
    );

    authoritative = { ...workspace, name: 'Newer tab name', revision: 3 };
    discoveryUnavailable = false;
    await actor.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(
      (await screen.findAllByText('Newer tab name')).length,
    ).toBeGreaterThan(0);
    expect(patchCount).toBe(1);
  });
  it('blocks dispatch after an identity change and removes the prior workspace session', async () => {
    let userReads = 0;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () => {
        userReads += 1;
        return userReads === 1
          ? HttpResponse.json(user)
          : problem(401, 'auth.unauthenticated', 'Session changed');
      }),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({ items: [workspace], nextCursor: null }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        return HttpResponse.json(renameResponse(workspace, false));
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Must not dispatch');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    await expectSignInPage();
    expect(patchCount).toBe(0);
  });
  it('removes rename actions after authoritative permission loss', async () => {
    let authorized = true;
    let patchCount = 0;
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        HttpResponse.json(user),
      ),
      http.get('http://pertexo.test/v1/workspaces', () =>
        HttpResponse.json({
          items: [
            authorized
              ? workspace
              : {
                  ...workspace,
                  role: 'viewer',
                  capabilities: ['workspace:read'],
                },
          ],
          nextCursor: null,
        }),
      ),
      http.patch(`http://pertexo.test/v1/workspaces/${workspaceId}`, () => {
        patchCount += 1;
        authorized = false;
        return problem(403, 'auth.forbidden', 'Access denied');
      }),
    );
    renderApp(`/w/${workspaceId}/settings`);
    const actor = userEvent.setup();
    await actor.click(
      await screen.findByRole('button', { name: 'Rename workspace' }),
    );
    const input = screen.getByLabelText('Workspace name');
    await actor.clear(input);
    await actor.type(input, 'Denied rename');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Rename workspace' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole('button', { name: 'Delete workspace' }),
    ).not.toBeInTheDocument();
    expect(patchCount).toBe(1);
  });
});
