import { createRequire } from 'node:module';
import { expect, type Page } from '@playwright/test';

// The browser build of the Guidepup Virtual Screen Reader: it reads the page's
// accessibility tree the way a screen reader does (names, roles, states, live
// regions) and logs what it would say.
const bundle = createRequire(import.meta.url).resolve(
  '@guidepup/virtual-screen-reader/browser.js',
);
const bundlePath = '/__screen-reader.js';

type Reader = Readonly<{
  start: (options: { container: Node }) => Promise<void>;
  stop: () => Promise<void>;
  spokenPhraseLog: () => Promise<string[]>;
  clearSpokenPhraseLog: () => Promise<void>;
}>;

declare global {
  interface Window {
    screenReader?: Reader;
  }
}

/**
 * Starts the virtual screen reader on the page that is loaded now. It hears
 * focus moves and live-region updates from then on; a full page load ends it,
 * so start it again after one.
 */
export async function startScreenReader(page: Page) {
  await page.route(`**${bundlePath}`, (route) =>
    route.fulfill({ path: bundle, contentType: 'text/javascript' }),
  );
  await page.evaluate(async (path) => {
    const { virtual } = (await import(path)) as { virtual: Reader };
    await window.screenReader?.stop();
    window.screenReader = virtual;
    await virtual.start({ container: document.body });
  }, bundlePath);
}

/** Everything the screen reader has said since it started or was cleared. */
function spoken(page: Page): Promise<string[]> {
  return page.evaluate(() => window.screenReader?.spokenPhraseLog() ?? []);
}

/** Forgets what was said so far, so the next assertion reads only new speech. */
export async function clearSpoken(page: Page) {
  await page.evaluate(() => window.screenReader?.clearSpokenPhraseLog());
}

/** The screen reader says a phrase matching `phrase`, now or soon. */
export async function expectSpoken(page: Page, phrase: RegExp) {
  await expect
    .poll(() => spoken(page))
    .toContainEqual(expect.stringMatching(phrase));
}

/**
 * The focused element has a role and a name, as a screen reader announces
 * it on arrival, and they match.
 */
export async function expectFocusOn(
  page: Page,
  role: Parameters<Page['getByRole']>[0],
  name: string | RegExp,
) {
  const focused = page.locator(':focus');
  await expect(focused).toHaveRole(role);
  await expect(focused).toHaveAccessibleName(name);
}
