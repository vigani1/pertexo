import { describe, expect, it, vi } from 'vitest';

import {
  SessionController,
  type CookieResponse,
  type IdentitySessionAuthority,
} from '../../src/identity-workspace/index.js';

describe('identity session controller', () => {
  it('clears cookies using the configured policy after logout revocation', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const controller = new SessionController(
      { revoke } as unknown as IdentitySessionAuthority,
      { secure: false, sameSite: 'strict' },
    );
    const response: CookieResponse = { header: vi.fn() };

    await controller.logout(
      {
        cookies: { pertexo_session: 'session-token-123456789012345678' },
      },
      response,
    );

    expect(revoke).toHaveBeenCalledWith('session-token-123456789012345678');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(response.header)).toHaveBeenCalledWith('set-cookie', [
      'pertexo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict',
      'pertexo_csrf=; Path=/; Max-Age=0; SameSite=Strict',
    ]);
  });
});
