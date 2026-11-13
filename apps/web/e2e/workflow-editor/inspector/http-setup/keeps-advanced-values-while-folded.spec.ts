import { expect, test } from '../../../support/fixtures';

import { addCsrfCookie, editorUrl } from '../../support';

import {
  httpDraft,
  installHttp,
  openAdvanced,
  openSetup,
  savedConfig,
} from './fixture';

for (const width of [375, 1280]) {
  test(`keeps what was typed under Advanced when it is folded at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = httpDraft();
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    const inline = page.getByLabel('Store as a file above (in kilobytes)', {
      exact: true,
    });
    // Advanced starts folded on a request that doesn't use it.
    await expect(response).toBeHidden();
    await openAdvanced(page);
    await inline.fill('80');
    await expect
      .poll(() => savedConfig(remote).inlineResponseBytes)
      .toBe(81_920);
    // Not valid yet, so not saved: only the field holds it.
    await response.fill('11');
    await response.press('Tab');
    const tooLarge = page.getByText('Largest response can be at most 10 MB.');
    await expect(tooLarge).toBeVisible();

    await openAdvanced(page);
    await expect(response).toBeHidden();
    await expect(inline).toBeHidden();
    await openAdvanced(page);
    await expect(response).toHaveValue('11');
    await expect(tooLarge).toBeVisible();
    await expect(inline).toHaveValue('80');
    expect(savedConfig(remote).maxResponseBytes).not.toBe(11_534_336);
  });
}
