import { describe, expect, it, vi } from 'vitest';

import {
  requestPasswordReset,
  resetPassword,
} from '@/features/auth/data/native-auth.api';
import type { ApiClient } from '@/lib/api/client';

describe('native authentication API', () => {
  it('uses the Better Auth password-reset request route', async () => {
    const request = vi.fn().mockResolvedValue({ status: true });
    const apiClient = { request } as unknown as ApiClient;

    await requestPasswordReset(apiClient, 'ada@example.test');

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/request-password-reset',
        method: 'POST',
        body: {
          email: 'ada@example.test',
          redirectTo: '/reset-password',
        },
      }),
    );
  });

  it('consumes a reset through the transactional Pertexo endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ status: true });
    const apiClient = { request } as unknown as ApiClient;
    await resetPassword(apiClient, {
      token: 'reset-token',
      password: 'a new password with enough characters',
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/account-security/password/reset',
        method: 'POST',
        body: {
          token: 'reset-token',
          newPassword: 'a new password with enough characters',
        },
      }),
    );
  });
});
