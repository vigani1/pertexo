import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { problem, user } from '../../../support/fixtures/team';
import { mockServer } from '../../../support/mock-server';
import {
  account,
  codes,
  identity,
  openSecurity,
  password,
  uri,
} from './fixture';

describe('two-factor setup refusals', () => {
  // Review J6a final P2: a mistyped code from someone still signed in is the
  // form's own error, not an ended session that pauses the page.
  it.each([
    [
      'auth.two_factor_code_invalid',
      'That code wasn’t accepted. Check it and try again.',
    ],
    [
      'auth.two_factor_challenge_expired',
      'This sign-in expired. Go back and sign in again.',
    ],
  ] as const)(
    'answers a %s refusal in the setup itself, without pausing',
    async (code, message) => {
      identity(() => account());
      mockServer.use(
        http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
          HttpResponse.json({ totpURI: uri, backupCodes: codes }),
        ),
        http.post('http://pertexo.test/v1/auth/two-factor/verify-totp', () =>
          problem(400, code),
        ),
      );
      const { actor } = await openSecurity();
      await actor.click(
        await screen.findByRole('button', {
          name: 'Turn on two-factor sign-in',
        }),
      );
      await password(actor, 'Continue');
      await actor.type(
        await screen.findByLabelText('Authenticator code'),
        '000000',
      );
      await actor.click(screen.getByRole('button', { name: 'Verify code' }));
      expect(await screen.findByText(message)).toBeVisible();
      expect(
        screen.queryByRole('heading', { name: 'Your session ended' }),
      ).toBeNull();
    },
  );

  // Review J6a delta P2: a code sent after the session ended answers
  // auth.unauthenticated, and the page pauses instead of blaming a sign-in.
  it('pauses the page when the session ended before the code was sent', async () => {
    let signedIn = true;
    identity(() => account());
    mockServer.use(
      http.get('http://pertexo.test/v1/users/me', () =>
        signedIn
          ? HttpResponse.json(user)
          : problem(401, 'auth.unauthenticated'),
      ),
      http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
        HttpResponse.json({ totpURI: uri, backupCodes: codes }),
      ),
      http.post('http://pertexo.test/v1/auth/two-factor/verify-totp', () =>
        problem(401, 'auth.unauthenticated'),
      ),
    );
    const { actor } = await openSecurity();
    await actor.click(
      await screen.findByRole('button', { name: 'Turn on two-factor sign-in' }),
    );
    await password(actor, 'Continue');
    await actor.type(
      await screen.findByLabelText('Authenticator code'),
      '000000',
    );
    signedIn = false;
    await actor.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(
      await screen.findByRole('heading', { name: 'Your session ended' }),
    ).toBeVisible();
    expect(
      screen.queryByText('This sign-in expired. Go back and sign in again.'),
    ).toBeNull();
  });
});
