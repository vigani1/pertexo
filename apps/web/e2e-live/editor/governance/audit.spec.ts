import { mkdir } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
for (const width of [1280, 375]) {
  test(`audit filters, retention and native CSV at ${String(width)}px`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
    if (origin === undefined) throw new Error('Mail owner missing');
    await page.setViewportSize({ width, height: 800 });
    await registerEditorUser(page, request, origin, 'Audit owner');
    const workspaceId = await createEditorWorkspace(
      page,
      `Audit qualification ${String(width)}`,
    );
    await page.goto(`/w/${workspaceId}/settings/audit`);
    await expect(
      page.getByRole('heading', { name: 'Audit log', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Keep audit events (days)')).toHaveValue(
      '365',
    );
    await page.getByLabel('Keep audit events (days)').fill('30');
    await page
      .getByRole('button', { name: 'Save retention', exact: true })
      .click();
    await expect(
      page.getByText('Retention saved.', { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('Action', { exact: true })
      .fill('workspace.governance_changed');
    await page
      .getByRole('button', { name: 'Apply filters', exact: true })
      .click();
    const events = page.getByRole('region', { name: 'Audit events' });
    await expect(
      events.getByText('workspace.governance_changed', { exact: true }),
    ).toBeVisible();
    await expect(events.getByRole('listitem')).toHaveCount(1);
    await events.getByText('Event details', { exact: true }).click();
    await expect(events.getByText('30', { exact: true })).toBeVisible();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export matching events' }).click();
    const result = await download;
    expect(result.suggestedFilename()).toBe('audit-log.csv');
    expect(await result.failure()).toBeNull();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await mkdir('/tmp/pertexo-audit-screenshots', { recursive: true });
    await page.screenshot({
      path: `/tmp/pertexo-audit-screenshots/audit-${String(width)}.png`,
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByLabel('Keep audit events (days)')).toHaveValue('30');
  });
}
