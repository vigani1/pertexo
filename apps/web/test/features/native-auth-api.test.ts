import { describe, expect, it, vi } from 'vitest';

import {
  requestPasswordReset,
  resetPassword,
} from '@/features/auth/native-auth.api';
import { startLegacyMethodMigration } from '@/features/auth/legacy-migration.api';
import type { ApiClient } from '@/lib/api/client';

describe('native authentication API', () => {
  it('starts pre-session legacy recovery without requiring a session CSRF token', async () => {
    const request = vi.fn().mockResolvedValue({
      authorizationUrl: 'https://identity.example.test/authorize',
      expiresAt: '2026-09-24T00:05:00.000Z',
    });
    const apiClient = { request } as unknown as ApiClient;

    await expect(startLegacyMethodMigration(apiClient, 'google')).resolves.toBe(
      'https://identity.example.test/authorize',
    );
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/auth/legacy-migration/start',
        method: 'POST',
        csrf: 'external',
        body: { provider: 'google' },
      }),
    );
  });

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
