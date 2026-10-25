import { httpPaginationSchema } from '@pertexo/integrations';

import { expect, test } from '../../../support/fixtures';

import { addCsrfCookie, editorUrl } from '../../support';

import {
  httpDefinition,
  httpDraft,
  installHttp,
  openSetup,
  savedConfig,
} from './fixture';

if (httpDefinition === undefined)
  throw new Error('HTTP definition is required');

for (const width of [375, 1280]) {
  test(`configures each pagination mode and keeps its bounds at ${String(width)}px`, async ({
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
    const section = page.locator('details').filter({
      has: page.locator('summary').filter({ hasText: 'Pagination' }),
    });
    await expect(section.locator('summary')).toHaveText('Pagination · Off');
    await expect(page.getByLabel('Items path', { exact: true })).toBeHidden();
    await section.locator('summary').click();
    const mode = page.getByLabel('Pagination mode', { exact: true });
    const choose = async (label: string) => {
      await mode.click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    const saved = () =>
      httpPaginationSchema.safeParse(savedConfig(remote).pagination).data;
    await expect(mode).not.toHaveAccessibleDescription(
      /Finish incomplete fields/u,
    );
    await choose('Next page link');
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveValue('$.next');
    const nextPath = page.getByLabel('Next link path', { exact: true });
    await nextPath.fill('$.items[');
    await nextPath.press('Tab');
    await expect(nextPath).toHaveAttribute('aria-invalid', 'true');
    await expect(mode).toBeDisabled();
    await expect(mode).toHaveAccessibleDescription(/Finish incomplete fields/u);
    await expect(
      page.getByLabel('Next link in', { exact: true }),
    ).toBeDisabled();
    await nextPath.fill('next');
    await expect(mode).toBeEnabled();
    await expect(mode).not.toHaveAccessibleDescription(
      /Finish incomplete fields/u,
    );
    await expect(
      page.getByLabel('Next link in', { exact: true }),
    ).toBeEnabled();
    await page.getByLabel('Items path', { exact: true }).fill('records');
    await page.getByLabel('Max pages', { exact: true }).fill('3');
    await expect.poll(() => saved()?.itemsPath).toBe('$.records');
    await expect.poll(() => saved()?.maxPages).toBe(3);
    await expect(
      page.getByLabel('Largest page (in kilobytes)', { exact: true }),
    ).toHaveValue('64');
    await choose('Cursor');
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Next cursor path', { exact: true }),
    ).toHaveValue('$.meta.next_cursor');
    await page.getByLabel('Query parameter', { exact: true }).fill('after');
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'cursor',
        parameter: 'after',
        itemsPath: '$.records',
        maxPages: 3,
      });
    const cursorPath = page.getByLabel('Next cursor path', { exact: true });
    await cursorPath.fill('$.items[');
    await cursorPath.press('Tab');
    await expect(cursorPath).toHaveAttribute('aria-invalid', 'true');
    await expect(mode).toBeDisabled();
    await cursorPath.fill('next_cursor');
    await expect(mode).toBeEnabled();
    await choose('Page number');
    await expect(
      page.getByLabel('Next cursor path', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('First page', { exact: true })).toHaveValue(
      '1',
    );
    await choose('Offset');
    await expect(page.getByLabel('First offset', { exact: true })).toHaveValue(
      '0',
    );
    await page.getByLabel('Offset step', { exact: true }).fill('50');
    await page
      .getByLabel('Delay between pages (in seconds)', { exact: true })
      .fill('0.25');
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'offset',
        step: 50,
        delayMillis: 250,
        maxPages: 3,
      });
    await page.getByLabel('Max pages', { exact: true }).fill('0');
    await page.getByLabel('Max pages', { exact: true }).press('Tab');
    await expect(page.getByLabel('Max pages', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(saved()?.maxPages).toBe(3);
    await expect(mode).toBeDisabled();
    await page.getByLabel('Max pages', { exact: true }).fill('3');
    await expect(mode).toBeEnabled();
    await choose('Next page link');
    await page.getByLabel('Next link in', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Link header', exact: true })
      .click();
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'next_link',
        source: { kind: 'link_header' },
        itemsPath: '$.records',
        maxPages: 3,
        delayMillis: 250,
      });
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await openSetup(page, width);
    await section.locator('summary').click();
    await expect(mode).toContainText('Next page link');
    await choose('Off');
    await expect.poll(() => savedConfig(remote).pagination).toBeUndefined();
    await expect(page.getByLabel('Items path', { exact: true })).toHaveCount(0);
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
  });
}
