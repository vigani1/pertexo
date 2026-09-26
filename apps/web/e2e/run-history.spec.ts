import { expect, test, type Page } from '@playwright/test';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const firstRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const secondRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const replayRunId = '11111111-1111-4111-8111-111111111111';
const csrfToken = 'csrf-token-for-run-replay-tests-123456789012345678';
const timestamp = '2026-09-15T10:00:00.000Z';

function run(
  id: string,
  status: 'failed' | 'succeeded',
  workflowName = 'Customer onboarding',
) {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId,
    workflowName,
    status,
    triggerType: 'manual',
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: '2026-09-15T10:00:02.000Z',
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

async function installRoutes(page: Page, workflowName?: string) {
  await page.route('**/v1/users/me', (route) =>
    route.fulfill({
      json: {
        id: userId,
        email: 'operator@example.test',
        displayName: 'Pertexo Operator',
        status: 'active',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    }),
  );
  await page.route('**/v1/workspaces?**', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: workspaceId,
            name: 'Control Operations',
            slug: 'control-operations',
            status: 'active',
            revision: 1,
            role: 'viewer',
            capabilities: [
              'workspace:read',
              'workflow:read',
              'run:read',
              'run:replay',
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  const workflow = {
    id: workflowId,
    workspaceId,
    name: 'Customer onboarding',
    nameRevision: 1,
    lifecycleStatus: 'active',
    lifecycleRevision: 1,
    activationStatus: 'active',
    publishedVersionId: workflowVersionId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({ json: { items: [workflow], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) => route.fulfill({ json: { workflow } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/run-statistics?**`,
    (route) =>
      route.fulfill({
        json: {
          asOf: '2026-09-15T10:00:00.000000Z',
          current: { queued: 0, running: 2, waiting: 1 },
          window: {
            duration: '24h',
            createdAtFrom: '2026-09-14T10:00:00.000000Z',
            createdAtBefore: '2026-09-15T10:00:00.000000Z',
            total: 0,
            byStatus: {
              queued: 0,
              running: 0,
              waiting: 0,
              succeeded: 0,
              failed: 0,
              canceled: 0,
              timed_out: 0,
              outcome_unknown: 0,
            },
          },
          workflows: null,
        },
      }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, (route) => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = query.get('status') === 'succeeded';
    const after = query.get('after');
    return route.fulfill({
      json: filtered
        ? {
            items: [run(firstRunId, 'succeeded', workflowName)],
            nextCursor: null,
          }
        : after === null
          ? {
              items: [run(firstRunId, 'succeeded', workflowName)],
              nextCursor: 'next',
            }
          : {
              items: [run(secondRunId, 'failed', workflowName)],
              nextCursor: null,
            },
    });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
    (route) =>
      route.fulfill({
        json: {
          run: run(firstRunId, 'succeeded', workflowName),
          nodes: [],
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${replayRunId}`,
    (route) =>
      route.fulfill({
        json: {
          run: {
            ...run(replayRunId, 'failed'),
            triggerType: 'replay',
          },
          nodes: [],
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: '',
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${replayRunId}/events`,
    (route) =>
      route.fulfill({
        contentType: 'text/event-stream',
        body: '',
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
    (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: workflowVersionId,
              workflowId,
              versionNumber: 1,
              schemaVersion: 1,
              graph: { schemaVersion: 1, nodes: [], edges: [], settings: {} },
              checksum:
                'wf:v1:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              publishedAt: timestamp,
            },
          ],
          nextCursor: null,
        },
      }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/replay`,
    async (route) => {
      expect(route.request().headers()['x-csrf-token']).toBe(csrfToken);
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      expect(route.request().postDataJSON()).toEqual({
        workflowVersionId,
        input: { incident: 'INC-42' },
      });
      const { workflowName, ...acceptedRun } = run(replayRunId, 'failed');
      void workflowName;
      await route.fulfill({
        status: 202,
        json: {
          run: {
            ...acceptedRun,
            triggerType: 'replay',
          },
          replayed: false,
        },
      });
    },
  );
}

test('filters and paginates workspace history, then opens the exact run', async ({
  page,
}) => {
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/runs`);

  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: /^Runs/u }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: 'Copy run ID eeee…eeee' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Workspace' })
      .getByRole('link', { name: 'Runs, 2 running' }),
  ).toBeVisible();
  await expect(page.getByText(firstRunId)).toHaveCount(0);
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(
    page.getByRole('button', { name: 'Copy run ID ffff…ffff' }),
  ).toBeVisible();

  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Succeeded' }).click();
  await expect(page).toHaveURL(/status=succeeded/u);
  await page.getByLabel('Workflow name').fill('Customer');
  await page.getByLabel('Workflow name').press('Enter');
  await expect(page).toHaveURL(/workflowNamePrefix=Customer/u);
  await page.getByRole('button', { name: 'When: Any time' }).click();
  // Today, twice: a range of just that day.
  const today = page.locator('button[aria-current="date"]');
  await today.click();
  await today.click();
  await page.getByRole('button', { name: 'Apply range' }).click();
  await expect(page).toHaveURL(/createdAtFrom=/u);
  await expect(page).toHaveURL(/range=custom/u);
  await expect(
    page.getByRole('button', { name: 'Copy run ID ffff…ffff' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Remove filter Status: Succeeded' })
    .click();
  await expect(page).not.toHaveURL(/status=succeeded/u);

  await page.getByRole('link', { name: 'Customer onboarding' }).first().click();
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Succeeded in/u }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'v1' })).toHaveAttribute(
    'href',
    `/w/${workspaceId}/workflows/${workflowId}/versions`,
  );
});

test('replays the exact displayed version with explicit input', async ({
  context,
  page,
}) => {
  await context.addCookies([
    { name: 'pertexo_csrf', value: csrfToken, url: 'http://127.0.0.1:4173' },
  ]);
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);

  await page.getByRole('button', { name: 'Replay' }).click();
  const dialog = page.getByRole('dialog', { name: 'Replay this run' });
  await expect(
    dialog.getByText(/It doesn’t copy the original input/u),
  ).toBeVisible();
  await dialog.getByLabel('Replay input (JSON)').fill('{"incident":"INC-42"}');
  await dialog.getByRole('button', { name: 'Replay run' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
  await expect(
    page.getByRole('button', { name: 'Copy run ID 1111…1111' }),
  ).toBeVisible();
  await expect(page.getByText('Replay started')).toBeVisible();
});

test('keeps a maximum-length workflow identity accessible and contained on mobile', async ({
  page,
}) => {
  const workflowName = 'W'.repeat(128);
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, workflowName);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);

  await expect(
    page.getByRole('heading', { level: 1, name: /^Succeeded in/u }),
  ).toBeVisible();
  // The breadcrumb names the workflow too; this is the header's own link.
  const name = page.getByRole('main').getByRole('link', { name: workflowName });
  await expect(name).toBeVisible();
  const box = await name.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await expect(
    page.getByRole('button', { name: 'Copy run ID eeee…eeee' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('contains long applied filters and keeps keyboard removal reachable', async ({
  page,
}, testInfo) => {
  const longPrefix = 'W'.repeat(128);
  await installRoutes(page);
  await page.goto(
    `/w/${workspaceId}/runs?workflowNamePrefix=${longPrefix}&workflowId=${workflowId}`,
  );

  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const chip = page.getByRole('button', {
      name: `Remove filter Name: ${longPrefix}`,
    });
    await expect(chip).toHaveAttribute('title', `Name: ${longPrefix}`);
    const box = await chip.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 390) {
      const screenshot = await page.screenshot({ fullPage: true });
      await testInfo.attach('long-applied-filter-390', {
        body: screenshot,
        contentType: 'image/png',
      });
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/long-applied-filter-390.png`,
          fullPage: true,
        });
    }
  }

  const prefixChip = page.getByRole('button', {
    name: `Remove filter Name: ${longPrefix}`,
  });
  await prefixChip.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/workflowNamePrefix=/u);
  await expect(page).toHaveURL(new RegExp(`workflowId=${workflowId}`, 'u'));
  await expect(
    page.getByRole('button', {
      name: 'Remove filter Workflow: Customer onboarding',
    }),
  ).toBeVisible();
});
