import type { Browser, Cookie } from '@playwright/test';
import { test as base } from '../../support/browser-fixture';
import { registerEditorUser } from '../../support/ordinary-editor-session';

const ownerNames = {
  product: 'Product owner',
  assistant: 'Assistant author',
  provider: 'Provider workflow author',
  evaluation: 'Evaluation workflow author',
  guardrails: 'Guardrails workflow author',
} as const;

type AccountGroup = keyof typeof ownerNames;
type ProductAccount = Readonly<{ cookies: readonly Cookie[]; email: string }>;

/**
 * Each group shares one signed-in account per worker and creates a new
 * workspace per test. This keeps both sign-ins per address and reads per
 * account within their budgets when the journey runs quickly.
 */
export const test = base.extend<
  { accountGroup: AccountGroup; productAccount: ProductAccount },
  { productAccounts: (group: AccountGroup) => Promise<ProductAccount> }
>({
  accountGroup: ['product', { option: true }],
  productAccounts: [
    async ({ browser }, runFixtures, workerInfo) => {
      const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
      if (mail === undefined) throw new Error('Use the owned API fixture');
      const { baseURL } = workerInfo.project.use;
      const accounts = new Map<AccountGroup, Promise<ProductAccount>>();
      await runFixtures((group) => {
        const existing = accounts.get(group);
        if (existing !== undefined) return existing;
        const account = registerAccount(
          browser,
          baseURL,
          mail,
          ownerNames[group],
        );
        accounts.set(group, account);
        return account;
      });
    },
    { scope: 'worker' },
  ],
  productAccount: async ({ accountGroup, productAccounts }, runFixtures) => {
    await runFixtures(await productAccounts(accountGroup));
  },
  context: async ({ context, productAccount }, runFixtures) => {
    await context.addCookies([...productAccount.cookies]);
    await runFixtures(context);
  },
});

async function registerAccount(
  browser: Browser,
  baseURL: string | undefined,
  mail: string,
  name: string,
): Promise<ProductAccount> {
  const context = await browser.newContext(
    baseURL === undefined ? {} : { baseURL },
  );
  try {
    const page = await context.newPage();
    const email = await registerEditorUser(page, context.request, mail, name);
    const { cookies } = await context.storageState();
    return { cookies, email };
  } finally {
    await context.close();
  }
}
