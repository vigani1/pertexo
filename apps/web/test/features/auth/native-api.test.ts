import { describe, expect, it, vi } from 'vitest';

import {
  requestPasswordReset,
  resetPassword,
  startSocialAuthentication,
} from '@/features/auth/data/native-auth.api';
import type { ApiClient } from '@/lib/api/client';

describe('native authentication API', () => {
  it.each([
    'https://identity.example/authorize',
    'http://localhost:4321/authorize',
  ])('accepts an allowed provider authorization URL: %s', async (url) => {
    const apiClient = {
      stream: vi.fn(),
      download: vi.fn(),
      request: vi.fn().mockResolvedValue({ url, redirect: true }),
    } satisfies ApiClient;
    await expect(startSocialAuthentication(apiClient, 'google')).resolves.toBe(
      url,
    );
  });
  it.each([
    'javascript://localhost/alert(1)',
    'data:text/html,script',
    'http://untrusted.example/authorize',
    'https://username:password@identity.example/authorize',
  ])('rejects unsupported provider schemes and hosts: %s', async (url) => {
    const apiClient = {
      stream: vi.fn(),
      download: vi.fn(),
      request: vi.fn().mockResolvedValue({ url, redirect: true }),
    } satisfies ApiClient;
    await expect(
      startSocialAuthentication(apiClient, 'google'),
    ).rejects.toThrow('provider URL was rejected');
  });
  it('uses the Better Auth password-reset request route', async () => {
    const request = vi.fn().mockResolvedValue({ status: true });
    const apiClient = {
      stream: vi.fn(),
      download: vi.fn(),
      request,
    } satisfies ApiClient;

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
    const apiClient = {
      stream: vi.fn(),
      download: vi.fn(),
      request,
    } satisfies ApiClient;
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
