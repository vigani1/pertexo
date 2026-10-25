import { API_TOKEN_SCOPES } from '@pertexo/contracts';
import {
  httpDraft,
  installHttp,
  openSetup,
  savedHttpNode,
} from '../workflow-editor/inspector/http-setup/fixture';
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, type Page } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  addCsrfCookie,
  editorUrl,
} from '../workflow-editor/support';
import { settings as federation } from '../../test/features/federation/fixtures';
import { fixtureUsageTrends } from '../../test/support/fixtures/usage-trends';
import { mockIdentity } from './auth/fixture';
import { fixtureRun, fixtureStatistics } from '../../test/support/fixtures/run';

test.describe.configure({ mode: 'parallel' });

const tableId = '10000000-0000-4000-8000-000000000001';
const runId = '10000000-0000-4000-8000-000000000002';
const table = {
  id: tableId,
  name: 'Customer orders',
  columns: [
    { id: 'reference', name: 'reference', type: 'text', required: true },
  ],
  keyColumn: null,
  hasRemovedColumns: false,
  rowCount: 0,
  storedBytes: 0,
  revision: 1,
};
const quotas = {
  tableLimit: 20,
  columnLimit: 20,
  rowLimit: 10000,
  byteLimit: 52428800,
  tableCount: 0,
  storedBytes: 0,
};
const viewports = [
  [390, 844],
  [360, 740],
  [768, 1024],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
] as const;
const capture = process.env.PERTEXO_POLISH_SHOTS;

async function routes(page: Page) {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      role: 'owner',
      capabilities: [
        ...workspace.capabilities,
        'workspace:manage',
        'workflow:create',
        'member:read',
        'member:manage',
        'connection:manage',
        'notification:read',
        'variable:manage',
        'audit:read',
        'governance:manage',
        'artifact:read',
      ],
    },
  });
  await page.route('**/v1/workspaces/*/run-statistics?**', (route) =>
    route.fulfill({
      json: fixtureStatistics({
        window:
          new URL(route.request().url()).searchParams.get('window') ?? '24h',
        workflows: [],
      }),
    }),
  );
  await page.route('**/v1/workspaces/*/runs?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/*/runs/${runId}`, (route) =>
    route.fulfill({ json: { run: fixtureRun(runId, 'succeeded'), nodes: [] } }),
  );
  await page.route('**/v1/workspaces/*/notifications?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null, revision: '0' } }),
  );
  await page.route('**/v1/workspaces/*/members?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/invitations?**', (route) =>
    route.fulfill({
      json: { items: [], nextCursor: null, issuanceAvailable: true },
    }),
  );
  await page.route('**/v1/workspaces/*/data-tables', (route) =>
    route.fulfill({
      json: {
        tables: new URL(page.url()).pathname.includes(tableId) ? [table] : [],
        quotas,
      },
    }),
  );
  await page.route('**/v1/workspaces/*/data-tables/*/rows/query', (route) =>
    route.fulfill({ json: { rows: [], affected: 0, hasMore: false } }),
  );
  await page.route('**/v1/workspaces/*/variables', (route) =>
    route.fulfill({ json: { revision: 0, values: {} } }),
  );
  await page.route('**/v1/workspaces/*/usage-capacity', (route) =>
    route.fulfill({
      json: {
        asOf: '2026-09-15T10:00:00.000000Z',
        execution: {
          activeRuns: 2,
          reservedActiveSlots: 1,
          activeCapacityConsumed: 3,
          queuedRuns: 4,
          policy: {
            state: 'active',
            version: 1,
            activeRunLimit: 5,
            queuedRunLimit: 100,
          },
        },
        artifacts: {
          chargedBytes: '1024',
          byteLimit: '52428800',
          chargedCount: 2,
          artifactCountLimit: 1000,
          source: 'stored',
        },
      },
    }),
  );
  await page.route('**/v1/workspaces/*/usage-trends?**', (route) =>
    route.fulfill({
      json: fixtureUsageTrends('30d', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    }),
  );
  await page.route('**/v1/workspaces/*/sso', (route) =>
    route.fulfill({ json: federation }),
  );
  await page.route('**/v1/workspaces/*/notifications/preferences', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        mode: null,
        hour: 9,
        timeZone: 'UTC',
        defaults: { revision: 0, mode: 'off', hour: 9, timeZone: 'UTC' },
        effective: { mode: 'off', hour: 9, timeZone: 'UTC' },
        canManageDefaults: true,
        emailAvailable: true,
        emailUnavailableReason: null,
      },
    }),
  );
  await page.route('**/v1/workspaces/*/promotions/settings', (route) =>
    route.fulfill({ json: { revision: 0, canConfigure: true, target: null } }),
  );
  await page.route('**/v1/workspaces/*/promotions/history?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/promotions/candidates?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/v1/workspaces/*/governance/settings', (route) =>
    route.fulfill({ json: { revision: 1, auditRetentionDays: 365 } }),
  );
  await page.route('**/v1/workspaces/*/governance/audit?**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    '**/v1/workspaces/*/failure-notification-destinations',
    (route) => route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/v1/workspaces/*/api-tokens?**', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        availableScopes: API_TOKEN_SCOPES,
        items: [],
        nextCursor: null,
      },
    }),
  );
}

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
      await routes(page);
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
        if (name === 'settings-usage')
          await expect(
            page
              .getByRole('region', { name: 'Current capacity' })
              .getByText('Runs at once', { exact: true }),
          ).toBeVisible();
        await shot(name);
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
    });
  }
