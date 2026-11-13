import type {
  APIRequestContext,
  Page,
  PlaywrightWorkerArgs,
  Request,
} from '@playwright/test';
import { workspaceVariablesResponseSchema } from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  createVerifiedEditorUser,
  registerEditorUser,
  submitSignInForm,
} from '../support/ordinary-editor-session';
import { expect } from '../editor/product/steps';

// Real sign-up mail and sign-in for two people behind one browser.
test.describe.configure({ timeout: 180_000 });

const SESSION_COOKIE = 'pertexo_session';

/**
 * Ends this page's session the way an expired cookie does, and keeps the
 * account's session in a separate client to read what the server holds.
 */
async function endSession(
  page: Page,
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string,
) {
  const server = await playwright.request.newContext({
    baseURL,
    storageState: await page.context().storageState(),
  });
  await page.context().clearCookies({ name: SESSION_COOKIE });
  return server;
}

async function readVariables(server: APIRequestContext, workspaceId: string) {
  const response = await server.get(`/v1/workspaces/${workspaceId}/variables`);
  expect(response.status()).toBe(200);
  return workspaceVariablesResponseSchema.parse(await response.json());
}

/** Types an unsaved edit into RATE, the way a person does. */
async function typeIntoRate(page: Page, value: string, description: string) {
  const rate = page.getByRole('region', { name: 'RATE', exact: true });
  await rate.getByRole('button', { name: 'Edit RATE', exact: true }).click();
  await rate.getByLabel('Value', { exact: true }).fill(value);
  await rate
    .getByLabel('Description (optional)', { exact: true })
    .fill(description);
}

/** Saves into the ended session and waits for the page to pause in place. */
async function saveIntoEndedSession(page: Page, path: string) {
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your session ended', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(path);
}

/** Signs in through the tab "Sign in again" opens, then closes that tab. */
async function signInAgainAs(page: Page, email: string) {
  const [signIn] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: /Sign in again/u }).click(),
  ]);
  await submitSignInForm(signIn, email);
  await expect(signIn).not.toHaveURL(/\/login/u);
  await signIn.close();
}

test('a page whose session ends keeps what was typed for the same person and none of it for the next', async ({
  baseURL,
  browser,
  page,
  playwright,
  request,
}) => {
  if (baseURL === undefined) throw new Error('Live origin missing');
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  const nextPerson = await browser.newContext({ baseURL });
  let nextEmail: string;
  try {
    nextEmail = await createVerifiedEditorUser(
      await nextPerson.newPage(),
      request,
      mail,
      'Next person at the desk',
    );
  } finally {
    await nextPerson.close();
  }
  const email = await registerEditorUser(page, request, mail, 'Paused owner');
  const workspaceId = await createEditorWorkspace(page, 'Paused page');
  const path = `/w/${workspaceId}/settings/variables`;
  await page.goto(path);
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  await page
    .getByRole('region', { name: 'New variable', exact: true })
    .getByLabel('Name', { exact: true })
    .fill('RATE');
  const rate = page.getByRole('region', { name: 'RATE', exact: true });
  await rate.getByLabel('Type', { exact: true }).selectOption('number');
  await rate.getByLabel('Value', { exact: true }).fill('10');
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await expect(
    page.getByText('Saved revision 1 for new runs', { exact: true }),
  ).toBeVisible();
  const writes: Request[] = [];
  page.on('request', (sent) => {
    if (sent.method() !== 'GET') writes.push(sent);
  });

  // The same person: everything typed is still there, and saves once.
  await typeIntoRate(page, '42', 'Typed before the session ended');
  let server = await endSession(page, playwright, baseURL);
  await saveIntoEndedSession(page, path);
  expect((await readVariables(server, workspaceId)).revision).toBe(1);
  await server.dispose();
  await signInAgainAs(page, email);
  await expect(
    page.getByRole('heading', { name: 'Your session ended', exact: true }),
  ).toBeHidden();
  await expect(rate.getByLabel('Value', { exact: true })).toHaveValue('42');
  await expect(
    rate.getByLabel('Description (optional)', { exact: true }),
  ).toHaveValue('Typed before the session ended');
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await expect(
    page.getByText('Saved revision 2 for new runs', { exact: true }),
  ).toBeVisible();
  // The interrupted save and the one after resuming: one of them changed it.
  const variablesPath = `/v1/workspaces/${workspaceId}/variables`;
  const saves = writes.filter(
    (sent) => sent.method() === 'PUT' && sent.url().endsWith(variablesPath),
  );
  const answers = await Promise.all(
    saves.map(async (sent) => (await sent.response())?.status()),
  );
  expect(answers).toEqual([401, 200]);

  // Someone else signs in: the paused input is discarded, and said to be.
  await typeIntoRate(page, '77', 'Typed by the first person');
  server = await endSession(page, playwright, baseURL);
  await saveIntoEndedSession(page, path);
  const sentBefore = writes.length;
  await signInAgainAs(page, nextEmail);
  await expect(
    page.getByText('Signed in as a different account', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      `You’re now signed in as ${nextEmail}. Unsaved changes on this page belonged to the other account, so they were discarded.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your session ended', exact: true }),
  ).toBeHidden();
  // None of the first person's work or data stays on screen.
  await expect(page.getByRole('region', { name: 'RATE' })).toHaveCount(0);
  await expect(page.getByText('Typed by the first person')).toHaveCount(0);
  await expect(page.getByText('Paused page', { exact: true })).toHaveCount(0);
  // And nothing held by the paused page goes out as the new person.
  await page.waitForTimeout(2_000);
  expect(
    writes
      .slice(sentBefore)
      .map((sent) => `${sent.method()} ${new URL(sent.url()).pathname}`)
      .filter((sent) => sent.includes(`/workspaces/${workspaceId}`)),
  ).toEqual([]);
  expect(await readVariables(server, workspaceId)).toMatchObject({
    revision: 2,
    values: { RATE: 42 },
  });
  await server.dispose();
});
