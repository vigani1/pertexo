import {
  httpDraft,
  installHttp,
  openSetup,
  savedHttpNode,
} from '../workflow-editor/inspector/http-setup/fixture';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect } from '../support/fixtures';
import {
  workspaceId,
  addCsrfCookie,
  editorUrl,
} from '../workflow-editor/support';
import { mockIdentity, workspace } from './auth/fixture';

import {
  captureInboxArrival,
  installPolishRoutes,
  runId,
  tableId,
} from './polish-layout-fixture';

import { WORKSPACE_TEXT_LIMITS } from '@pertexo/workflow-model';

test('keeps a maximum-length workspace slug inside the General header on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const slug = 'm'.repeat(WORKSPACE_TEXT_LIMITS.slugCharacters);
  await mockIdentity(page, {
    authenticated: true,
    workspaces: [{ ...workspace, slug }],
  });
  await page.goto(`/w/${workspaceId}/settings`);
  const metadata = page.locator('main header p').filter({ hasText: slug });
  await expect(metadata).toBeVisible();
  expect(
    await metadata.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});

test.describe.configure({ mode: 'parallel' });

const viewports = [
  [390, 844],
  [360, 740],
  [768, 1024],
  [1024, 768],
  [1280, 900],
  [1440, 900],
  [1920, 1080],
] as const;
const capture = process.env.PERTEXO_POLISH_SHOTS;

for (const [width, height] of viewports)
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`polish pages stay bounded at ${String(width)}x${String(height)} in ${colorScheme}`, async ({
      page,
      context,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await mockIdentity(page, { authenticated: false });
      const shot = async (name: string) => {
        await page.locator('main').waitFor();
        await page.waitForTimeout(200);
        await page.evaluate(() => document.fonts.ready);
        if (capture) {
          const directory = capture;
          await mkdir(directory, { recursive: true });
          await page.screenshot({
            path: `${directory}/${name}-${String(width)}x${String(height)}-${colorScheme}.png`,
            fullPage: (await page.getByRole('dialog').count()) === 0,
          });
        }
        expect
          .soft(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
            `${name} horizontal overflow`,
          )
          .toBe(true);
        if (capture)
          await writeFile(
            `${capture}/${name}-${String(width)}x${String(height)}-${colorScheme}.json`,
            JSON.stringify(
              await page.evaluate(() => ({
                overflow: [
                  ...document.querySelectorAll('main *,[role="dialog"] *'),
                ]
                  .filter((element) => {
                    const rect = element.getBoundingClientRect();
                    return (
                      rect.width > 0 &&
                      (rect.left < -1 || rect.right > innerWidth + 1) &&
                      getComputedStyle(element).position !== 'absolute'
                    );
                  })
                  .slice(0, 20)
                  .map((element) => ({
                    tag: element.tagName,
                    text: element.textContent.slice(0, 80),
                  })),
                smallTargets: [
                  ...document.querySelectorAll(
                    'main button,main input:not([type="hidden"]),main [role="tab"],[role="dialog"] button',
                  ),
                ]
                  .filter((element) => {
                    const rect = element.getBoundingClientRect();
                    return (
                      rect.width > 0 &&
                      rect.height > 0 &&
                      rect.top < innerHeight &&
                      rect.bottom > 0 &&
                      rect.height < 43.9
                    );
                  })
                  .map((element) => ({
                    tag: element.tagName,
                    name:
                      element.getAttribute('aria-label') ??
                      element.textContent.slice(0, 80),
                    height: element.getBoundingClientRect().height,
                  })),
              })),
              null,
              2,
            ),
          );
      };
      await page.goto('/login');
      await shot('login');
      await page.goto('/sign-up');
      await shot('sign-up');
      await installPolishRoutes(page);
      await addCsrfCookie(context);
      const root = `/w/${workspaceId}`;
      const screens: readonly (readonly [string, string])[] = [
        ['workspaces', '/workspaces'],
        ['home', root],
        ['workflows', `${root}/workflows`],
        ['runs', `${root}/runs`],
        ['run-detail', `${root}/runs/${runId}`],
        ['inbox', `${root}/inbox`],
        ['tables', `${root}/data-tables`],
        ['table-detail', `${root}/data-tables/${tableId}`],
        ['connections', `${root}/connections`],
        ['account', `${root}/account`],
        ['workflow-settings', `${editorUrl.replace(/\/$/u, '')}/settings`],
        ['team', `${root}/team`],
        ...[
          '',
          'usage',
          'usage/trends',
          'variables',
          'alerts',
          'promotion',
          'audit',
          'sso',
          'notifications',
          'api-tokens',
        ].map((section): readonly [string, string] => [
          `settings${section ? '-' + section.replace('/', '-') : ''}`,
          `${root}/settings${section ? '/' + section : ''}`,
        ]),
      ];
      for (const [name, path] of screens) {
        await page.goto(path);
        if (name === 'settings-usage') {
          const capacity = page.getByRole('region', { name: 'Room left' });
          await expect(
            capacity.getByRole('heading', { name: 'Room left' }),
          ).toBeVisible();
          await expect(
            capacity.getByText(/Right now .* runs at once/u),
          ).toBeVisible();
          await expect(
            capacity.getByRole('img', { name: /of file storage used/u }),
          ).toBeVisible();
        }
        await shot(name);
        if (name === 'settings-audit' || name === 'runs') {
          if (name === 'runs')
            await page.getByRole('button', { name: 'When: Any time' }).click();
          const day = page.locator('button[aria-current="date"]');
          await day.click();
          await expect(day).toHaveAttribute('aria-pressed', 'true');
          await shot(`${name}-calendar`);
          await page.keyboard.press('Escape');
        }
      }
      await page.goto(`${root}/workflows`);
      await page
        .getByRole('button', { name: 'Import workflow…', exact: true })
        .click();
      await shot('workflow-import');
      await page.keyboard.press('Escape');
      await page.goto(`${root}/data-tables`);
      await page
        .getByRole('button', { name: 'New table', exact: true })
        .click();
      const newTable = page.getByRole('dialog', { name: 'New data table' });
      const drawerBounds = await newTable.boundingBox();
      expect(drawerBounds).not.toBeNull();
      if (width < 600) expect(drawerBounds?.width).toBe(width);
      await shot('new-table');
      await page.keyboard.press('Escape');
      await page.goto(`${root}/data-tables/${tableId}`);
      await page.getByRole('button', { name: 'Add row', exact: true }).click();
      await shot('add-row');
      await page.keyboard.press('Escape');
      await page
        .getByRole('button', { name: 'Import CSV', exact: true })
        .click();
      await shot('csv-import');
      await page.keyboard.press('Escape');
      const remote = httpDraft();
      const initial = savedHttpNode(remote);
      remote.graph = {
        ...remote.graph,
        nodes: [{ ...initial, config: { ...initial.config, method: 'POST' } }],
      };
      await installHttp(page, remote);
      await page.goto(editorUrl);
      await openSetup(page, width);
      await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
      await page
        .getByRole('button', { name: 'Form parts', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Add file part', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Upload part file', exact: true })
        .click();
      await shot('upload-file');
      await captureInboxArrival(page, shot);
    });
  }
