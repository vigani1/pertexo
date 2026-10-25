import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { user } from '../../../support/fixtures/team';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
export const codes = Array.from(
  { length: 10 },
  (_, i) => `recovery-${String(i).padStart(5, '0')}`,
);

export const uri =
  'otpauth://totp/Pertexo:test?secret=JBSWY3DPEHPK3PXP&issuer=Pertexo';

export function account(enabled = false, remaining: number | null = null) {
  return {
    email: user.email,
    emailVerified: true,
    availableProviders: [],
    methods: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        kind: 'password',
        provider: null,
      },
    ],
    twoFactor: { enabled, recoveryCodesRemaining: remaining },
  };
}

export function identity(read: () => ReturnType<typeof account>) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
    http.get('http://pertexo.test/v1/auth/account-security', () =>
      HttpResponse.json(read()),
    ),
  );
}

export async function openSecurity() {
  const view = renderApp('/account/security', { strict: true });
  const actor = userEvent.setup();
  await actor.click(
    await screen.findByRole('tab', { name: 'Sign-in & security' }),
  );
  return { ...view, actor };
}

export async function password(
  actor: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  await actor.type(
    within(screen.getByRole('dialog')).getByLabelText('Current password'),
    'correct horse battery staple',
  );
  await actor.click(
    within(screen.getByRole('dialog')).getByRole('button', {
      name: label,
    }),
  );
}
