import { screenReaderConfig } from '@guidepup/playwright';
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// The real VoiceOver journeys, run on a macOS runner by
// .github/workflows/simulate-browsers.yml. VoiceOver is one per machine and
// reads only a visible window, so one test runs at a time, headed.
export default defineConfig({
  ...base,
  ...screenReaderConfig,
  testDir: './e2e/screen-reader',
  testMatch: '**/*.voiceover.ts',
  projects: [
    {
      name: 'voiceover',
      use: { ...base.use, ...devices['Desktop Safari'], headless: false },
    },
  ],
});
