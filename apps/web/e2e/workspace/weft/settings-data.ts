import type { Page } from '@playwright/test';
import { API_TOKEN_SCOPES } from '@pertexo/policy';
import { AUTHENTICATION_PROVIDERS } from '@pertexo/workflow-model';
import { user, workspaceId } from '../../workflow-editor/support';

const workspaceApi = `**/v1/workspaces/${workspaceId}`;

export async function installSettingsRoutes(page: Page) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86_400_000 * 30).toISOString();
  await page.route('**/v1/auth/account-security', (route) =>
    route.fulfill({
      json: {
        email: user.email,
        emailVerified: true,
        availableProviders: AUTHENTICATION_PROVIDERS,
        twoFactor: { enabled: true, recoveryCodesRemaining: 2 },
        methods: [{ id: user.id, kind: 'password', provider: null }],
      },
    }),
  );
  await page.route('**/v1/auth/account-security/sessions', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: user.id,
            current: true,
            createdAt,
            updatedAt: createdAt,
            expiresAt,
            ipAddress: '203.0.113.24',
            userAgent: null,
          },
        ],
      },
    }),
  );
  await page.route(`${workspaceApi}/api-tokens?**`, (route) =>
    route.fulfill({
      json: {
        enabled: true,
        availableScopes: API_TOKEN_SCOPES,
        nextCursor: null,
        items: [
          {
            id: user.id,
            workspaceId,
            name: 'Build runner',
            scopes: API_TOKEN_SCOPES.slice(0, 2),
            status: 'active',
            createdAt,
            expiresAt,
            revokedAt: null,
            lastUsedAt: null,
          },
        ],
      },
    }),
  );
  await page.route(
    `${workspaceApi}/failure-notification-destinations`,
    (route) =>
      route.fulfill({
        json: {
          systemMail: { available: true },
          items: [
            {
              id: user.id,
              workspaceId,
              kind: 'system_mail',
              status: 'enabled',
              currentVersion: 1,
              config: { kind: 'system_mail', memberId: user.id },
              createdAt,
              updatedAt: createdAt,
            },
          ],
        },
      }),
  );
}
