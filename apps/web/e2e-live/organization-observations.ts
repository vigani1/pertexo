import { expect } from '@playwright/test';

import { test } from './support/browser-fixture';

import { observation } from './workflow-organization/fixture';

export function installOrganizationObservations() {
  test.beforeEach(({ page }) => {
    observation.lastIdentityStatus = 0;
    observation.failedControl = null;
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.includes('/auth/'))
        observation.lastIdentityStatus = response.status();
    });
  });

  test.afterEach(async ({ request, page }, info) => {
    if (process.env.PERTEXO_LIVE_MAIL_ORIGIN !== undefined) {
      const result = await request.post(
        `${process.env.PERTEXO_LIVE_MAIL_ORIGIN}/organization-test-result`,
        {
          data: {
            case:
              info.title ===
              'ordinary owner persists shared organization, exact recovery and private discovery filters'
                ? 'owner'
                : 'unknown',
            status: info.status === 'passed' ? 'passed' : 'failed',
          },
        },
      );
      expect(result.status()).toBe(204);
    }
    if (
      info.status === 'passed' ||
      process.env.PERTEXO_LIVE_MAIL_ORIGIN === undefined
    )
      return;
    const line = Number(
      info.error?.stack?.match(/workflow-organization\.spec\.ts:(\d+)/u)?.[1] ??
        0,
    );
    await request.post(
      `${process.env.PERTEXO_LIVE_MAIL_ORIGIN}/organization-failure`,
      {
        data: {
          line,
          control: observation.failedControl,
          identityStatus: observation.lastIdentityStatus,
          identityStage: [
            '/sign-up',
            '/login',
            '/verify-email',
            '/workspaces',
          ].includes(new URL(page.url()).pathname)
            ? new URL(page.url()).pathname
            : 'other',
        },
      },
    );
    if (/^\/w\/[0-9a-f-]+\/workflows$/u.test(new URL(page.url()).pathname))
      await page.screenshot({
        path: '/tmp/pertexo-f07-creation-public.png',
        fullPage: true,
      });
  });
}
