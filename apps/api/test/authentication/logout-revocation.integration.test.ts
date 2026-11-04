import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  betterAuthIntegrationEnabled,
  useBetterAuthRealApi,
} from '../support/better-auth/real-api.support.js';

describe.runIf(betterAuthIntegrationEnabled)('authoritative logout', () => {
  const api = useBetterAuthRealApi('logout_revoke');

  it('reports deletion failures without clearing cookies, and revokes the retained cookie before reporting success', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(200);
    await api
      .database()
      .query('revoke delete on app.auth_sessions from pertexo_app');
    try {
      const failed = await api.send('POST', '/v1/auth/logout', { browser });
      expect(failed.statusCode).toBe(500);
      expect(failed.headers['set-cookie']).toBeUndefined();
      expect(
        (await api.send('GET', '/v1/users/me', { browser })).statusCode,
      ).toBe(200);
    } finally {
      await api
        .database()
        .query('grant delete on app.auth_sessions to pertexo_app');
    }
    const loggedOut = await api.send('POST', '/v1/auth/logout', { browser });
    expect(loggedOut.statusCode).toBe(204);
    expect(loggedOut.headers['set-cookie']).toBeDefined();
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(401);
    const rows = await api.database().query('select id from app.auth_sessions');
    expect(rows.rows).toEqual([]);
  });

  it('refuses native sign-out, including trailing slashes, without claiming revocation or clearing cookies', async () => {
    const email = `${randomUUID()}@example.test`;
    await api.signUp(email, '/login?verified=true');
    const browser = await api.signIn(email);
    for (const path of ['/v1/auth/sign-out', '/v1/auth/sign-out/']) {
      const response = await api.send('POST', path, { browser });
      expect(response.statusCode).toBe(404);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(200);
    expect(
      (await api.send('POST', '/v1/auth/logout', { browser })).statusCode,
    ).toBe(204);
    expect(
      (await api.send('GET', '/v1/users/me', { browser })).statusCode,
    ).toBe(401);
  });
});
