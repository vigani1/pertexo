import type { Cookie } from '@playwright/test';
import { test as base } from '../../support/browser-fixture';
import { registerEditorUser } from '../../support/ordinary-editor-session';

/**
 * The product journey's specs share one signed-in account, each in a new
 * workspace of its own. Signing every spec up and in would spend the identity
 * budget (10 sign-ups and sign-ins a minute per address) on a fast machine;
 * none of these specs tests signing in itself.
 */
export const test = base.extend<
  // Playwright's way to declare that this adds no test-scoped fixtures.
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
  Record<never, never>,
  { productAccount: readonly Cookie[] }
>({
  productAccount: [
    async ({ browser }, runFixtures, workerInfo) => {
      const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
      if (mail === undefined) throw new Error('Use the owned API fixture');
      const baseURL = workerInfo.project.use.baseURL;
      const context = await browser.newContext(
        baseURL === undefined ? {} : { baseURL },
      );
      const page = await context.newPage();
      await registerEditorUser(page, context.request, mail, 'Product owner');
      const { cookies } = await context.storageState();
      await context.close();
      await runFixtures(cookies);
    },
    { scope: 'worker' },
  ],
  context: async ({ context, productAccount }, runFixtures) => {
    await context.addCookies([...productAccount]);
    await runFixtures(context);
  },
});
