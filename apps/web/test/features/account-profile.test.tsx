import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { problem, timestamp, user } from '../support/team-fixtures';

type Rename = Readonly<{ key: string | null; body: unknown }>;

function accountHandlers(profile: () => typeof user) {
  return [
    http.get('http://pertexo.test/v1/users/me', () =>
      HttpResponse.json(profile()),
    ),
    http.get('http://pertexo.test/v1/auth/account-security', () =>
      HttpResponse.json({
        email: user.email,
        emailVerified: true,
        availableProviders: [],
        methods: [],
      }),
    ),
  ];
}

function renameHandler(
  renames: Rename[],
  answer: (attempt: number, body: { displayName: string }) => Response,
) {
  return http.patch('http://pertexo.test/v1/users/me', async ({ request }) => {
    const body = (await request.json()) as { displayName: string };
    renames.push({ key: request.headers.get('idempotency-key'), body });
    return answer(renames.length, body);
  });
}

function receipt(displayName: string, revision: number) {
  return HttpResponse.json({
    profile: { ...user, displayName, revision, updatedAt: timestamp },
    changed: true,
    replayed: false,
  });
}

async function editName(actor: ReturnType<typeof userEvent.setup>) {
  await actor.click(
    await screen.findByRole('button', { name: 'Edit your name' }),
  );
  return screen.getByLabelText('Your name');
}

describe('account: display name', () => {
  it('renames in place at the profile revision and confirms with a toast', async () => {
    let profile = user;
    const renames: Rename[] = [];
    mockServer.use(
      ...accountHandlers(() => profile),
      renameHandler(renames, (_attempt, body) => {
        profile = { ...user, displayName: body.displayName, revision: 2 };
        return receipt(body.displayName, 2);
      }),
    );
    const actor = userEvent.setup();
    renderApp('/account/security', { strict: true });

    const input = await editName(actor);
    await actor.clear(input);
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText('Enter the name teammates should see.'),
    ).toBeVisible();
    await actor.type(input, '  Ada Lovelace ');
    await actor.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Your name is now Ada Lovelace'),
    ).toBeVisible();
    const profileSection = within(
      screen.getByRole('region', { name: 'Profile' }),
    );
    expect(await profileSection.findByText('Ada Lovelace')).toBeVisible();
    expect(renames).toEqual([
      {
        key: expect.any(String) as unknown,
        body: { displayName: 'Ada Lovelace', expectedRevision: 1 },
      },
    ]);
  });

  it('repeats an unconfirmed rename exactly and keeps the edit through a conflict', async () => {
    let profile = user;
    const renames: Rename[] = [];
    mockServer.use(
      ...accountHandlers(() => profile),
      renameHandler(renames, (attempt, body) => {
        if (attempt === 1) return HttpResponse.error();
        if (attempt === 2) {
          profile = { ...user, displayName: 'Changed Elsewhere', revision: 2 };
          return problem(412, 'user.profile_revision_conflict');
        }
        return receipt(body.displayName, 3);
      }),
    );
    const actor = userEvent.setup();
    renderApp('/account/security');

    const input = await editName(actor);
    await actor.clear(input);
    await actor.type(input, 'Grace Hopper');
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/couldn’t confirm whether your name changed/u),
    ).toBeVisible();
    expect(input).toBeDisabled();
    await actor.click(screen.getByRole('button', { name: 'Try again' }));

    expect(
      await screen.findByText(
        /changed somewhere else and is now “Changed Elsewhere”/u,
      ),
    ).toBeVisible();
    expect(renames[1]).toEqual(renames[0]);
    await actor.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Your name is now Grace Hopper'),
    ).toBeVisible();
    expect(renames[2]?.body).toEqual({
      displayName: 'Grace Hopper',
      expectedRevision: 2,
    });
    expect(renames[2]?.key).not.toBe(renames[0]?.key);
  });
});
