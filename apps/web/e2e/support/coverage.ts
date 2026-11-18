import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { test as base } from '../../test/support/temporary-test-path';

// Records the JavaScript each test runs in Chromium, for the hand-started
// overlap run (infrastructure/testing/overlap/run-spec-coverage.mjs). It is
// off unless the config passes `coverageDirectory`, which only that run sets;
// off, every fixture below hands the original object through untouched.
//
// A document's counts are gone once the next one loads, so coverage is taken
// before every navigation the test starts, as soon as the app asks for one
// (a sign-in redirect, a reload button), and when the page or test ends.
// Each take resets V8's counters; the reach is the union of all takes.

interface ScriptCoverage {
  url: string;
  functions: unknown[];
}

const NAVIGATIONS = ['goto', 'reload', 'goBack', 'goForward'] as const;

/** Collects coverage from every page of every context the browser opens. */
class CoverageRecorder {
  private readonly sessions = new Map<Page, Promise<CDPSession>>();
  private collected: ScriptCoverage[] = [];

  constructor(private readonly directory: string) {}

  /** Starts coverage on each page a context opens, and keeps it on close. */
  track(context: BrowserContext): void {
    context.on('page', (page) => {
      this.sessions.set(page, this.start(context, page));
      for (const name of NAVIGATIONS) {
        const navigate = page[name].bind(page) as (
          ...args: unknown[]
        ) => Promise<unknown>;
        Object.assign(page, {
          [name]: async (...args: unknown[]) => {
            await this.take(page);
            return navigate(...args);
          },
        });
      }
      const closePage = page.close.bind(page);
      page.close = async (options) => {
        await this.take(page);
        this.sessions.delete(page);
        await closePage(options);
      };
    });
    // A page the test opens records from its first navigation, so the entry
    // chunk's start-up is counted too.
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      await this.sessions.get(page);
      return page;
    };
    const closeContext = context.close.bind(context);
    context.close = async (options) => {
      const pages = context.pages();
      await Promise.all(pages.map((page) => this.take(page)));
      for (const page of pages) this.sessions.delete(page);
      await closeContext(options);
    };
  }

  /** Writes what this test ran and starts afresh for the next test. */
  async flush(testId: string): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((page) => this.take(page)));
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(
      join(this.directory, `${testId}.json`),
      JSON.stringify({ result: this.collected }),
    );
    this.collected = [];
  }

  private async start(context: BrowserContext, page: Page) {
    const session = await context.newCDPSession(page);
    await session.send('Profiler.enable');
    await session.send('Profiler.startPreciseCoverage', {
      callCount: true,
      detailed: true,
    });
    const { frameTree } = await session.send('Page.getFrameTree');
    await session.send('Page.enable');
    session.on('Page.frameRequestedNavigation', ({ frameId }) => {
      // The old document lives until the new one's response arrives.
      if (frameId === frameTree.frame.id) void this.take(page);
    });
    return session;
  }

  /** Adds what the page ran since the last take. */
  private async take(page: Page): Promise<void> {
    const session = this.sessions.get(page);
    if (session === undefined || page.isClosed()) return;
    const { result } = await (
      await session
    ).send('Profiler.takePreciseCoverage');
    for (const { url, functions } of result)
      if (url.startsWith('http')) this.collected.push({ url, functions });
  }
}

/** The option playwright.config.ts sets for the overlap run alone. */
export interface CoverageOptions {
  coverageDirectory: string | undefined;
}

export const test = base.extend<
  { jsCoverage: undefined },
  CoverageOptions & { coverageRecorder: CoverageRecorder | undefined }
>({
  coverageDirectory: [undefined, { option: true, scope: 'worker' }],
  coverageRecorder: [
    async ({ coverageDirectory }, useRecorder) => {
      await useRecorder(
        coverageDirectory === undefined
          ? undefined
          : new CoverageRecorder(coverageDirectory),
      );
    },
    { scope: 'worker' },
  ],
  browser: [
    async ({ browser, coverageRecorder }, useBrowser) => {
      if (coverageRecorder !== undefined)
        browser.on('context', (context) => {
          coverageRecorder.track(context);
        });
      await useBrowser(browser);
    },
    { scope: 'worker' },
  ],
  jsCoverage: [
    async ({ coverageRecorder }, runTest, info) => {
      await runTest(undefined);
      await coverageRecorder?.flush(info.testId);
    },
    { auto: true },
  ],
});
