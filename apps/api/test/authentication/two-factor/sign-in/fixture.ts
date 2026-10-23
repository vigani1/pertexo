import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';

import {
  enrollFactor,
  challengeCookie,
  factorPassword,
} from '../../../support/better-auth/two-factor.js';
import { useOrganizationApi } from '../../federation/organization/fixture.js';

function useFactorApi(suite: string) {
  const api = useOrganizationApi(suite);
  async function person() {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/workspaces');
    const original = await api.signIn(email);
    return { email, original, ...(await enrollFactor(api, original)) };
  }
  async function challenge(email: string, password = factorPassword) {
    const reply = await api.send('POST', '/v1/auth/sign-in/email', {
      payload: { email, password },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toEqual({
      twoFactorRedirect: true,
      twoFactorMethods: ['totp'],
    });
    return challengeCookie(reply);
  }
  const verify = (cookie: string, code: string, backup = false) =>
    api.send(
      'POST',
      `/v1/auth/two-factor/${backup ? 'verify-backup-code' : 'verify-totp'}`,
      { headers: { cookie }, payload: { code } },
    );
  return { api, person, challenge, verify };
}

export function createAuthenticatorFixture() {
  const { api, person, challenge, verify } = useFactorApi('2fa_codes');
  return { person, challenge, api, verify };
}

export function createRecoveryFixture() {
  const { api, person, challenge, verify } = useFactorApi('2fa_recovery');
  return { person, challenge, verify, api };
}

export function createFactorManagementFixture() {
  const { api, person, challenge, verify } = useFactorApi('2fa_manage');
  return { person, verify, challenge, api };
}

export function createFactorResetFixture() {
  const { api, person, challenge, verify } = useFactorApi('2fa_reset');
  return { person, api, challenge, verify };
}

export function createFactorLockoutFixture({
  backup,
}: {
  readonly backup: boolean;
}) {
  const { api, person, challenge, verify } = useFactorApi(
    backup ? '2fa_backup_lockout' : '2fa_lockout',
  );
  return { person, verify, challenge, backup, api };
}

export function createFactorOrganizationFixture() {
  const { api, challenge, verify } = useFactorApi('2fa_org');
  return { api, challenge, verify };
}

export function createFactorAdmissionFixture() {
  const api = useOrganizationApi('2fa_admit');
  return { api };
}
