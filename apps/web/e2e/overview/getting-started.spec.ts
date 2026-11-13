import { workflowListBody } from '../workflows/list-support';
import { csrfToken, run } from '../run-history/fixture';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';
import { expect, test, type Page } from '../support/fixtures';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const timestamp = '2026-11-13T10:00:00.000Z';

// The base before J6a moved Home by 0.106 at 375 px and 0.026 at 1280 px
// while it loaded (review J6a P2-3); Home must not move more than that.
const BASE_SHIFT = { 375: 0.106, 1280: 0.026 } as const;

const noRuns = {
  queued: 0,
  running: 0,
  waiting: 0,
  succeeded: 0,
  failed: 0,
  canceled: 0,
  timed_out: 0,
  outcome_unknown: 0,
};

async function newWorkspace(page: Page) {
  await page.clock.setFixedTime(new Date(timestamp));
  // Cookies ignore the port, so this reaches whichever port serves the app.
  await page
    .context()
    .addCookies([
      { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1' },
    ]);
  const imports: unknown[] = [];
  await page.route('**/v1/**', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      json: {
        type: 'about:blank',
        title: 'Not found',
        status: 404,
        code: 'resource.not_found',
        requestId: 'getting-started',
      },
    }),
  );
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: createUserFixture({
        id: userId,
        email: 'owner@example.test',
        displayName: 'Workspace Owner',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          createWorkspaceFixture({
            id: workspaceId,
            capabilities: [
              'workspace:read',
              'workflow:read',
              'workflow:create',
              'run:read',
              'connection:read',
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: workflowListBody(route.request().url(), []) }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/run-statistics?**`,
    (route) =>
      route.fulfill({
        json: {
          asOf: '2026-11-13T10:00:00.000000Z',
          current: { queued: 0, running: 0, waiting: 0 },
          window: {
            duration: '24h',
            createdAtFrom: '2026-11-12T10:00:00.000000Z',
            createdAtBefore: '2026-11-13T10:00:00.000000Z',
            total: 0,
            byStatus: noRuns,
          },
          workflows: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/import/preview`,
    (route) =>
      route.fulfill({
        json: {
          manifestDigest: 'b'.repeat(64),
          compatibilityFingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
          compatible: true,
          issues: [],
          truncated: false,
          connectionSlots: [],
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/import`,
    async (route) => {
      imports.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, json: { workflowId } });
    },
  );
  // Every shift from the first paint on, not only after the page settles.
  await page.addInitScript(() => {
    const record = window as unknown as { __shift: number };
    record.__shift = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
      }[])
        if (!entry.hadRecentInput) record.__shift += entry.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  return imports;
}

for (const width of [375, 1280] as const)
  test(`a new workspace's Home settles without jumping and starts the example at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const imports = await newWorkspace(page);
    await page.goto(`/w/${workspaceId}`);
    const section = page.getByRole('region', { name: 'Getting started' });
    await expect(section).toBeVisible();
    const offer = section.getByRole('button', { name: 'Try the example' });
    await expect(offer).toBeVisible();
    await expect(
      section.getByRole('link', { name: /Read the first-workflow guide/u }),
    ).toHaveAttribute('target', '_blank');
    // One Getting started, never a quiet one swapped for the full one.
    await expect(
      page.getByRole('region', { name: 'Getting started' }),
    ).toHaveCount(1);
    await page.waitForTimeout(1_000);
    const shift = await page.evaluate(
      () => (window as unknown as { __shift: number }).__shift,
    );
    expect(shift).toBeLessThanOrEqual(BASE_SHIFT[width]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`getting-started-${String(width)}.png`),
    });

    await offer.click();
    await expect(page).toHaveURL(
      `/w/${workspaceId}/workflows/${workflowId}?guide=first-run`,
    );
    expect(imports).toHaveLength(1);
  });

/** The same workspace after its first run: one published workflow, one run. */
async function afterFirstRun(page: Page) {
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({
      json: workflowListBody(route.request().url(), [
        {
          id: workflowId,
          workspaceId,
          name: 'Say hello',
          nameRevision: 1,
          lifecycleStatus: 'active',
          lifecycleRevision: 1,
          activationStatus: 'inactive',
          webhookSetupRequired: false,
          publishedVersionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, (route) =>
    route.fulfill({
      json: {
        items:
          new URL(route.request().url()).searchParams.get('status') === null
            ? [run('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'succeeded')]
            : [],
        nextCursor: null,
      },
    }),
  );
}

for (const width of [375, 1280] as const)
  test(`keeps the unfinished setup tasks, quieter, after the first run at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await newWorkspace(page);
    await afterFirstRun(page);
    await page.goto(`/w/${workspaceId}`);
    const section = page.getByRole('region', { name: 'Getting started' });
    await expect(section).toBeVisible();
    await expect(section).toContainText('3 of 4 done.');
    const connection = section.getByRole('link', { name: 'Add a connection' });
    await expect(connection).toHaveAttribute(
      'href',
      `/w/${workspaceId}/connections?add=any`,
    );
    await expect(
      section.getByRole('button', { name: 'Try the example' }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test
        .info()
        .outputPath(`getting-started-after-${String(width)}.png`),
      fullPage: true,
    });
  });
