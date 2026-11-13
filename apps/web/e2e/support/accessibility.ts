import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

const THEMES = ['light', 'dark'] as const;

/**
 * Axe finds no WCAG 2.1 A/AA failure (contrast, semantics, landmarks) in
 * what the page shows now, in each theme. Axe checks only what is
 * rendered, so call it once the state under test is on screen.
 */
export async function expectAccessibleInBothThemes(page: Page) {
  const found: unknown[] = [];
  for (const theme of THEMES) {
    await page.evaluate((choice) => {
      const root = document.documentElement;
      root.dataset.theme = choice;
      root.classList.toggle('dark', choice === 'dark');
      root.style.colorScheme = choice;
    }, theme);
    const wcag = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    // Content outside a landmark is best practice, not WCAG; the audit
    // asked for it too.
    const landmarks = await new AxeBuilder({ page })
      .withRules(['region'])
      .analyze();
    const violations = [...wcag.violations, ...landmarks.violations];
    found.push(
      ...violations.map(({ id, nodes }) => ({
        theme,
        rule: id,
        nodes: nodes.map(({ target, html }) => `${target.join(' ')} ${html}`),
      })),
    );
  }
  expect(found).toEqual([]);
}
