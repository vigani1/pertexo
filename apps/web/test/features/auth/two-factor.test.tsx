import { act, screen, waitFor, within } from '@testing-library/react';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { problem, user } from '../../support/fixtures/team';

import { mockServer } from '../../support/mock-server';

import {
  account,
  codes,
  identity,
  openSecurity,
  password,
  uri,
} from './two-factor/fixture';

describe('two-factor account controls', () => {
  it.each([0, 1, 2])(
    'describes %i recovery codes clearly',
    async (remaining) => {
      identity(() => account(true, remaining));
      await openSecurity();
      expect(
        await screen.findByText(
          `On · ${String(remaining)} recovery ${remaining === 1 ? 'code' : 'codes'} remaining`,
        ),
      ).toBeVisible();
      expect(
        await screen.findByText(
          remaining === 0
            ? 'No recovery codes left. Get new codes now.'
            : `Only ${String(remaining)} recovery ${remaining === 1 ? 'code' : 'codes'} left. Get new codes before you need them.`,
        ),
      ).toBeVisible();
    },
  );
  it('verifies the first code, shows recovery codes once and keeps secrets out of caches', async () => {
    let enabled = false;
    identity(() => account(enabled, enabled ? 10 : null));
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/two-factor/enable',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBeTruthy();
          expect(await request.json()).toEqual({
            password: 'correct horse battery staple',
          });
          return HttpResponse.json({ totpURI: uri, backupCodes: codes });
        },
      ),
      http.post(
        'http://pertexo.test/v1/auth/two-factor/verify-totp',
        async ({ request }) => {
          expect(request.headers.get('x-csrf-token')).toBeTruthy();
          expect(await request.json()).toEqual({ code: '123456' });
          enabled = true;
          return HttpResponse.json({ user: { id: user.id } });
        },
      ),
    );
    const { actor, queryClient } = await openSecurity();
    await actor.click(
      await screen.findByRole('button', { name: 'Turn on two-factor sign-in' }),
    );
    await password(actor, 'Continue');
    expect(
      await screen.findByRole('img', { name: /Scan this QR code/u }),
    ).toBeVisible();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
    await actor.type(screen.getByLabelText('Authenticator code'), '123 456');
    await actor.click(screen.getByRole('button', { name: 'Verify code' }));
    expect(
      await screen.findByRole('list', { name: 'Recovery codes' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download .txt' })).toBeEnabled();
    await actor.click(
      screen.getByRole('checkbox', { name: 'I’ve saved these codes' }),
    );
    await actor.click(screen.getByRole('button', { name: 'Done' }));
    expect(
      await screen.findByText('On · 10 recovery codes remaining'),
    ).toBeVisible();
    expect(screen.queryByText(codes[0] ?? '')).toBeNull();
    const cache = JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
    );
    expect(cache).not.toContain('JBSWY');
    expect(cache).not.toContain('recovery-00000');
    expect(cache).not.toContain('correct horse');
    expect(queryClient.getMutationCache().getAll()).toEqual([]);
  });
  it('warns at two codes, replaces them once and turns off after confirming the password', async () => {
    let enabled = true;
    let count = 2;
    identity(() => account(enabled, enabled ? count : null));
    mockServer.use(
      http.post(
        'http://pertexo.test/v1/auth/two-factor/generate-backup-codes',
        async ({ request }) => {
          expect((await request.json()) as unknown).toEqual({
            password: 'correct horse battery staple',
          });
          count = 10;
          return HttpResponse.json({ backupCodes: codes });
        },
      ),
      http.post('http://pertexo.test/v1/auth/two-factor/disable', () => {
        enabled = false;
        return HttpResponse.json({ status: true });
      }),
    );
    const { actor } = await openSecurity();
    expect(
      await screen.findByText(/Only 2 recovery codes left/u),
    ).toBeVisible();
    await actor.click(
      screen.getByRole('button', { name: 'Get new recovery codes' }),
    );
    await password(actor, 'Get new recovery codes');
    expect(
      await screen.findByRole('list', { name: 'Recovery codes' }),
    ).toBeVisible();
    await actor.click(
      screen.getByRole('checkbox', { name: 'I’ve saved these codes' }),
    );
    await actor.click(screen.getByRole('button', { name: 'Done' }));
    await actor.click(
      await screen.findByRole('button', {
        name: 'Turn off two-factor sign-in',
      }),
    );
    await password(actor, 'Turn off two-factor sign-in');
    expect(
      await screen.findByRole('button', { name: 'Turn on two-factor sign-in' }),
    ).toBeEnabled();
  });
  it('keeps verification open and finishes only after authoritative metadata refreshes', async () => {
    let verified = false;
    let verifying = false;
    let refreshing = false;
    let releaseVerification: () => void = () => undefined;
    let releaseRefresh: () => void = () => undefined;
    const verification = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const refresh = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    identity(() => account());
    mockServer.use(
      http.get('http://pertexo.test/v1/auth/account-security', async () => {
        if (verified) {
          refreshing = true;
          await refresh;
        }
        return HttpResponse.json(account(verified, verified ? 10 : null));
      }),
      http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
        HttpResponse.json({ totpURI: uri, backupCodes: codes }),
      ),
      http.post(
        'http://pertexo.test/v1/auth/two-factor/verify-totp',
        async () => {
          verifying = true;
          await verification;
          verified = true;
          return HttpResponse.json({ user: { id: user.id } });
        },
      ),
    );
    try {
      const { actor } = await openSecurity();
      await actor.click(
        await screen.findByRole('button', {
          name: 'Turn on two-factor sign-in',
        }),
      );
      await password(actor, 'Continue');
      await actor.type(
        await screen.findByLabelText('Authenticator code'),
        '123456',
      );
      await actor.click(screen.getByRole('button', { name: 'Verify code' }));
      await waitFor(() => {
        expect(verifying).toBe(true);
      });
      await actor.keyboard('{Escape}');
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(
        screen.getByRole('button', { name: 'Cancel setup' }),
      ).toBeDisabled();
      releaseVerification();
      expect(
        await screen.findByRole('list', { name: 'Recovery codes' }),
      ).toBeVisible();
      await actor.click(
        screen.getByRole('checkbox', { name: 'I’ve saved these codes' }),
      );
      await actor.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => {
        expect(refreshing).toBe(true);
      });
      expect(screen.getByRole('dialog')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Finishing…' })).toBeDisabled();
      releaseRefresh();
      expect(
        await screen.findByRole('button', {
          name: 'Turn off two-factor sign-in',
        }),
      ).toBeVisible();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'Turn on two-factor sign-in' }),
      ).toBeNull();
    } finally {
      releaseVerification();
      releaseRefresh();
    }
  });
  for (const status of [503, 403]) {
    it(`handles a ${String(status)} metadata refresh while recovery codes are open`, async () => {
      let verified = false;
      let refuseRead = false;
      identity(() => account());
      mockServer.use(
        http.get('http://pertexo.test/v1/auth/account-security', () =>
          refuseRead
            ? problem(
                status,
                status === 403
                  ? 'auth.forbidden'
                  : 'request.rate_limit_unavailable',
              )
            : HttpResponse.json(account(verified, verified ? 10 : null)),
        ),
        http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
          HttpResponse.json({ totpURI: uri, backupCodes: codes }),
        ),
        http.post('http://pertexo.test/v1/auth/two-factor/verify-totp', () => {
          verified = true;
          return HttpResponse.json({ user: { id: user.id } });
        }),
      );
      const { actor, queryClient } = await openSecurity();
      await actor.click(
        await screen.findByRole('button', {
          name: 'Turn on two-factor sign-in',
        }),
      );
      await password(actor, 'Continue');
      await actor.type(
        await screen.findByLabelText('Authenticator code'),
        '123456',
      );
      await actor.click(screen.getByRole('button', { name: 'Verify code' }));
      expect(
        await screen.findByRole('list', { name: 'Recovery codes' }),
      ).toBeVisible();
      refuseRead = true;
      await act(async () => {
        await queryClient.invalidateQueries({
          queryKey: ['account-security', user.id],
        });
      });
      if (status === 403) {
        await waitFor(() => {
          expect(
            screen.queryByRole('list', { name: 'Recovery codes' }),
          ).toBeNull();
          expect(screen.queryByRole('dialog')).toBeNull();
        });
        return;
      }
      await screen.findByText(/Couldn’t refresh\. Showing results from/u);
      expect(
        screen.getByRole('list', { name: 'Recovery codes' }),
      ).toBeVisible();
      await actor.click(
        screen.getByRole('checkbox', { name: 'I’ve saved these codes' }),
      );
      await actor.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).toBeNull();
      });
      expect(
        screen.getByRole('button', { name: 'Turn on two-factor sign-in' }),
      ).toBeDisabled();
      refuseRead = false;
      await actor.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        await screen.findByRole('button', {
          name: 'Turn off two-factor sign-in',
        }),
      ).toBeEnabled();
    });
  }
  it('explains a wrong password and clears it for a fresh entry', async () => {
    identity(() => account());
    mockServer.use(
      http.post('http://pertexo.test/v1/auth/two-factor/enable', () =>
        problem(400, 'request.invalid'),
      ),
    );
    const { actor } = await openSecurity();
    await actor.click(
      await screen.findByRole('button', { name: 'Turn on two-factor sign-in' }),
    );
    await password(actor, 'Continue');
    expect(
      await screen.findByText(
        'Your current password wasn’t accepted. Check it and try again.',
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole('dialog')).getByLabelText('Current password'),
    ).toHaveValue('');
    expect(screen.queryByRole('list', { name: 'Recovery codes' })).toBeNull();
  });
});
