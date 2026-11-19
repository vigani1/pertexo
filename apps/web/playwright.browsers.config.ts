import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// The browser simulation (.github/workflows/simulate-browsers.yml): the whole
// mocked suite in Firefox and WebKit, and the narrow-screen journeys on a real
// phone profile of each engine. CI's browser job uses playwright.config.ts,
// which never sees these projects.

// Journeys written for a phone or a narrow screen. Playwright matches it
// against the project name too, so no project name may contain these words.
const narrowScreen =
  /phone|narrow|mobile|small screen|\b[23]\d\dpx|\b[23]\d\d pixels|\b[23]\d\d×/iu;

// Playwright's WebKit reports no download for a form POST answered with an
// attachment, even to the same tab, where Firefox and Chromium do (checked
// 2026-11-19 with a bare form), so the native exports that work this way
// are left to the other engines here. Real Safari is not checked.
const formPostDownload = /@form-post-download/u;

export default defineConfig({
  ...base,
  projects: [
    { name: 'firefox', use: devices['Desktop Firefox'] },
    {
      name: 'webkit',
      grepInvert: formPostDownload,
      use: devices['Desktop Safari'],
    },
    {
      name: 'ios-safari',
      grep: narrowScreen,
      grepInvert: formPostDownload,
      use: devices['iPhone 15'],
    },
    { name: 'android-chrome', grep: narrowScreen, use: devices['Pixel 7'] },
  ],
});
