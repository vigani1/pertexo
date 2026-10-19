import { APIError } from 'better-auth/api';
import { describe, expect, it, vi } from 'vitest';

import type { BetterAuthRuntime } from '../../src/authentication/better-auth/runtime.js';
import { BetterAuthSessionService } from '../../src/authentication/better-auth/session-service.js';
import { IdentityError } from '../../src/identity/errors.js';

function serviceWhereLookup(lookup: () => Promise<unknown>) {
  const runtime = {
    sessions: { authenticate: vi.fn(lookup) },
  } as unknown as BetterAuthRuntime;
  return new BetterAuthSessionService(runtime, {
    secure: false,
    sameSite: 'lax',
    ttlSeconds: 3_600,
  });
}

describe('Better Auth session authentication', () => {
  it('calls a session that no longer exists invalid', async () => {
    await expect(
      serviceWhereLookup(() => Promise.resolve(undefined)).authenticate('t'),
    ).rejects.toMatchObject({ code: 'identity.session_invalid' });
    await expect(
      serviceWhereLookup(() =>
        Promise.reject(new APIError('UNAUTHORIZED')),
      ).authenticate('t'),
    ).rejects.toBeInstanceOf(IdentityError);
  });

  it('lets a failed lookup through instead of calling the session invalid', async () => {
    const outage = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    const failed = serviceWhereLookup(() => Promise.reject(outage));
    await expect(failed.authenticate('t')).rejects.toBe(outage);
    const internal = new APIError('INTERNAL_SERVER_ERROR');
    await expect(
      serviceWhereLookup(() => Promise.reject(internal)).authenticate('t'),
    ).rejects.toBe(internal);
  });
});
