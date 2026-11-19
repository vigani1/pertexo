import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { PUBLIC_HOSTS } from '../../support/overlay.mjs';
import { IDP_HOSTS, NETWORK } from './identity-network.mjs';

// A person's browser on the simulated internet: Chromium, with the public names
// resolved the way DNS would and each person in their own profile.
const webRequire = createRequire(
  new URL('../../../../../../apps/web/package.json', import.meta.url),
);
export const APP = `https://${PUBLIC_HOSTS.app}`;
const FAILED_NOTICE = /Organization sign-in did not finish/u;

let appAuthority;
const flowReplies = new WeakMap();

/** `authority` is the app certificate's CA, for reads made beside the browser. */
export async function launchBrowser({ authority }) {
  appAuthority = authority;
  const { chromium } = webRequire('@playwright/test');
  const rules = [
    `MAP ${PUBLIC_HOSTS.app} ${NETWORK.server}`,
    ...Object.values(IDP_HOSTS).map((host) => `MAP ${host} ${NETWORK.edge}`),
  ].join(', ');
  return chromium.launch({ args: [`--host-resolver-rules=${rules}`] });
}

/**
 * A person with their own browser profile. Records what reached Pertexo's
 * callbacks so a scenario can replay or inspect it.
 */
export async function openPerson(browser) {
  // The simulation's certificate authorities stand in for public ones; the
  // browser isn't what is under test, so it accepts them.
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const callbacks = [];
  // What a provider's flow API answered: the stage shown and its errors.
  page.on('response', (response) => {
    if (!response.url().includes('/api/v3/flows/executor/')) return;
    response
      .json()
      .then((body) => {
        flowReplies.set(page, [
          ...(flowReplies.get(page) ?? []).slice(-4),
          {
            status: response.status(),
            method: response.request().method(),
            component: body.component,
            errors: body.response_errors,
          },
        ]);
      })
      .catch(() => undefined);
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/v1/auth/federation/oidc/callback')
      callbacks.push({ protocol: 'oidc', url: request.url() });
    if (url.pathname === '/v1/auth/federation/saml/callback')
      callbacks.push({ protocol: 'saml', body: request.postData() });
  });
  return { context, page, callbacks, close: () => context.close() };
}

/**
 * Whether the provider shows its sign-in form (`field`), or still has a
 * session and has already sent the browser back to Pertexo.
 */
export async function asksForSignIn(page, field) {
  const shown = Promise.race([
    field.waitFor({ timeout: 60_000 }).then(() => true),
    // Back on Pertexo, past the login page the sign-in started from.
    page
      .waitForURL(
        (url) =>
          url.origin === APP &&
          !(url.pathname === '/login' && url.search === ''),
        { timeout: 60_000 },
      )
      .then(() => false),
  ]);
  return shown.catch((error) => stuck(page, error));
}

/** Says where the browser got stuck and what that page said. */
async function stuck(page, error) {
  // Providers render inside shadow roots, which innerText doesn't enter.
  const text = await page
    .evaluate(() => {
      const parts = [];
      const walk = (root) => {
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) walk(node.shadowRoot);
          if (node.matches('input'))
            parts.push(`[input ${node.name || node.type}]`);
          else if (node.childElementCount === 0 && node.textContent?.trim())
            parts.push(node.textContent.trim());
        }
      };
      walk(globalThis.document);
      return parts.join(' | ');
    })
    .catch(() => '');
  const directory = process.env.SIMULATION_SCREENSHOTS;
  if (directory)
    await page
      .screenshot({
        path: `${directory}/stuck-${Date.now()}.png`,
        fullPage: true,
      })
      .catch(() => undefined);
  const replies = JSON.stringify(flowReplies.get(page) ?? []);
  throw new Error(`Stuck at ${page.url()}: ${text.slice(0, 1500)} ${replies}`, {
    cause: error,
  });
}

/**
 * Rewrites the next SAML response the browser posts to Pertexo, the way an
 * attacker edits their own response in flight. Resolves once it was sent.
 */
export function tamperNextSamlResponse(
  page,
  transform,
  { delayMillis = 0 } = {},
) {
  const pattern = `${APP}/v1/auth/federation/saml/callback`;
  return new Promise((resolve, reject) => {
    page
      .route(
        pattern,
        async (route) => {
          try {
            const original = route.request().postData();
            const body = transform(original);
            if (delayMillis > 0)
              await new Promise((done) => setTimeout(done, delayMillis));
            await route.continue({
              postData: body,
              headers: {
                ...route.request().headers(),
                'content-length': String(Buffer.byteLength(body)),
              },
            });
            resolve({ original, sent: body });
          } catch (error) {
            reject(error);
          }
        },
        { times: 1 },
      )
      .catch(reject);
  });
}

/** What the login page says when the per-address sign-in budget is spent. */
const LIMITED =
  /isn’t available right now|could not start|could not be checked|Too many attempts/u;
/** Pertexo's sign-in budgets count requests per address over one minute. */
const BUDGET_WINDOW_MILLIS = 61_000;
const limited = [];

/** Waits out the budget window, so the next sign-ins start with a full budget. */
export const waitForFreshSignInBudget = () =>
  new Promise((done) => setTimeout(done, BUDGET_WINDOW_MILLIS));

/** Each time a person was turned away by a sign-in budget, and what they read. */
export const limitedSignIns = () => [...limited];

/**
 * Organization sign-in from the login page. `atProvider` signs in at the
 * identity provider; leave it out when the provider still has a session.
 * Every simulated person shares one address, so a sign-in the page turns away
 * for its per-address budget is retried after the window, as a person told to
 * "try again in a moment" does; `retry: false` reports the refusal instead.
 * Resolves to where the browser landed and what the login page said.
 */
export async function signInWithOrganization(
  page,
  { domain, provider, atProvider, retry = true, timeout },
) {
  for (let attempt = 0; ; attempt += 1) {
    const refused = await startOrganizationSignIn(page, domain, provider);
    if (refused === undefined) break;
    limited.push({ at: new Date().toISOString(), shown: refused });
    if (!retry || attempt === 2)
      return {
        path: new URL(page.url()).pathname,
        signedIn: false,
        notice: refused,
      };
    await page.waitForTimeout(BUDGET_WINDOW_MILLIS);
  }
  if (atProvider) await atProvider(page);
  return landing(page, { timeout });
}

/** Starts the sign-in; returns what the page said if it was turned away. */
async function startOrganizationSignIn(page, domain, provider) {
  await page.goto(`${APP}/login`);
  const turnedAway = page.getByText(LIMITED).first();
  const entry = page.getByRole('button', {
    name: 'Organization sign-in',
    exact: true,
  });
  await entry
    .or(turnedAway)
    .waitFor()
    .catch((error) => stuck(page, error));
  if (await turnedAway.isVisible()) return turnedAway.textContent();
  await entry.click();
  await page.getByLabel('Organization domain', { exact: true }).fill(domain);
  await page.getByRole('button', { name: 'Find sign-in', exact: true }).click();
  const choice = page.getByRole('button', {
    name: `Continue with ${provider}`,
    exact: true,
  });
  await choice.or(turnedAway).waitFor();
  if (await turnedAway.isVisible()) return turnedAway.textContent();
  await choice.click();
  const left = await Promise.race([
    page
      // Away to the provider, or straight back when it still has a session.
      .waitForURL(
        (url) =>
          url.origin !== APP || url.pathname !== '/login' || url.search !== '',
        { timeout: 30_000 },
      )
      .then(() => true),
    turnedAway.waitFor({ timeout: 30_000 }).then(() => false),
  ]).catch(() => true);
  return left ? undefined : turnedAway.textContent();
}

/** Waits until the browser is back on Pertexo's pages and reports the outcome. */
export async function landing(page, { timeout = 60_000 } = {}) {
  await page
    .waitForURL(
      (url) =>
        url.origin === APP &&
        !url.pathname.startsWith('/v1/') &&
        !url.pathname.startsWith('/auth/') &&
        // The login page the sign-in started from; a refusal adds ?ssoError.
        !(url.pathname === '/login' && url.search === ''),
      { timeout },
    )
    .catch((error) => stuck(page, error));
  const url = new URL(page.url());
  const refused = url.pathname === '/login';
  const notice = refused
    ? await page
        .getByText(FAILED_NOTICE)
        .first()
        .textContent({ timeout: 10_000 })
        .catch(() => null)
    : null;
  return { path: url.pathname + url.search, signedIn: !refused, notice };
}

/**
 * A GET with the person's own cookies, as their open tab's scripts would send
 * it. Playwright's request API doesn't use the browser's name mapping.
 */
export async function appGet(page, path) {
  const cookies = await page.context().cookies(APP);
  return new Promise((resolve, reject) => {
    const sent = httpsRequest(
      {
        host: NETWORK.server,
        port: 443,
        servername: PUBLIC_HOSTS.app,
        ca: appAuthority,
        path,
        headers: {
          host: PUBLIC_HOSTS.app,
          accept: 'application/json',
          cookie: cookies
            .map(({ name, value }) => `${name}=${value}`)
            .join('; '),
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // Problems and pages may not be JSON.
          }
          resolve({ status: response.statusCode, json });
        });
      },
    );
    sent.once('error', reject);
    sent.end();
  });
}

export async function currentUser(page) {
  const response = await appGet(page, '/v1/users/me');
  return {
    status: response.status,
    user: response.status === 200 ? response.json : null,
  };
}

export async function workspacesOf(page) {
  const response = await appGet(page, '/v1/workspaces');
  if (response.status !== 200) return { status: response.status, items: [] };
  return {
    status: response.status,
    items: response.json.items ?? response.json.workspaces,
  };
}

/** Signs out from the account menu, as a person does. */
export async function signOut(page) {
  await page.goto(`${APP}/workspaces`);
  await page.getByRole('button', { name: /^Account menu for/u }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.waitForURL(`${APP}/login**`);
}

export async function signInWithPassword(page, { email, password }) {
  const emailField = page.getByLabel('Email', { exact: true });
  const turnedAway = page.getByText(LIMITED).first();
  for (let attempt = 0; ; attempt += 1) {
    await page.goto(`${APP}/login`);
    await emailField.or(turnedAway).waitFor();
    if (!(await turnedAway.isVisible()) || attempt === 2) break;
    limited.push({
      at: new Date().toISOString(),
      shown: await turnedAway.textContent(),
    });
    await page.waitForTimeout(BUDGET_WINDOW_MILLIS);
  }
  await emailField.fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

/**
 * The owner's "Test sign-in" from the settings page: starts the test in the
 * signed-in owner's browser, signs in at the provider and returns what the
 * settings page then says.
 */
export async function testProvider(
  page,
  { protocol, workspaceId, domainId, providerId, atProvider },
) {
  await page.goto(`${APP}/w/${workspaceId}/settings/sso`);
  const started = await page.evaluate(
    async ({ protocol, body }) => {
      const csrf = globalThis.document.cookie
        .split(';')
        .map((part) => part.trim().split('='))
        .find(([name]) => name === 'pertexo_csrf')?.[1];
      const response = await fetch(`/v1/auth/federation/${protocol}/test`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': decodeURIComponent(csrf ?? ''),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.text() };
    },
    { protocol, body: { workspaceId, domainId, providerId } },
  );
  if (started.status !== 200)
    throw new Error(
      `The test did not start: ${started.status} ${started.body}`,
    );
  await page.goto(JSON.parse(started.body).authorizationUrl);
  if (atProvider) await atProvider(page);
  await page.waitForURL(
    (url) => url.origin === APP && url.searchParams.has('ssoTest'),
    { timeout: 60_000 },
  );
  const url = new URL(page.url());
  const result = url.searchParams.get('ssoTest');
  const reason = url.searchParams.get('ssoReason');
  // What the owner reads: the page's own explanation of the result.
  // The settings page explains the result once it has loaded.
  const shown = await page
    .getByRole('alert')
    .or(page.getByRole('status'))
    .filter({ hasNotText: /Opening/u })
    .first()
    .textContent({ timeout: 10_000 })
    .catch(() => null);
  return { result, reason, shown };
}

/** Posts a SAML response to Pertexo's callback from `page`, as an IdP's form does. */
export async function postSamlResponse(page, body) {
  await page.goto(`${APP}/login`);
  const fields = Object.fromEntries(new URLSearchParams(body));
  await page.evaluate(
    ({ action, fields }) => {
      const form = globalThis.document.createElement('form');
      form.method = 'POST';
      form.action = action;
      for (const [name, value] of Object.entries(fields)) {
        const input = globalThis.document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.append(input);
      }
      globalThis.document.body.append(form);
      form.submit();
    },
    { action: `${APP}/v1/auth/federation/saml/callback`, fields },
  );
  await page.waitForURL(
    (url) => url.pathname !== '/login' || url.search !== '',
  );
  return landing(page);
}
