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
  await expect(page.getByText(firstRunId)).toBeVisible();
  await page.getByRole('button', { name: 'Load more' }).click();
  await expect(page.getByText(secondRunId)).toBeVisible();

  await page.getByLabel('Status').selectOption('succeeded');
  await page.getByLabel('Workflow name starts with').fill('Customer');
  await page.getByRole('button', { name: 'Add filters' }).click();
  await page.getByLabel('Created from').fill('2026-09-14');
  await page.getByLabel('Created before').fill('2026-09-16');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/status=succeeded/u);
  await expect(page).toHaveURL(/workflowNamePrefix=Customer/u);
  await expect(page).toHaveURL(/createdAtFrom=2026-09-14/u);
  await expect(page.getByText(secondRunId)).not.toBeVisible();
  await page
    .getByRole('button', { name: 'Remove filter Status: succeeded' })
    .click();
  await expect(page).not.toHaveURL(/status=succeeded/u);

  await page.getByRole('link', { name: `Open run ${firstRunId}` }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(
    page.getByRole('heading', { name: 'Customer onboarding' }),
  ).toBeVisible();
  await expect(page.getByText(workflowVersionId)).toBeVisible();
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

  await page.getByRole('button', { name: 'Replay run' }).click();
  await expect(
    page.getByText(
      /does not copy hidden input or assume earlier provider effects/u,
    ),
  ).toBeVisible();
  await page.getByLabel('Replay input (JSON)').fill('{"incident":"INC-42"}');
  await page.getByRole('button', { name: 'Replay this version' }).click();

  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
  await expect(page.getByText(replayRunId)).toBeVisible();
});

test('keeps a maximum-length workflow identity accessible and contained on mobile', async ({
  page,
}) => {
  const workflowName = 'W'.repeat(128);
  await page.setViewportSize({ width: 390, height: 844 });
  await installRoutes(page, workflowName);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);

  const heading = page.getByRole('heading', { name: workflowName });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
  await expect(page.getByText(firstRunId, { exact: false })).toBeVisible();
  await expect(page.getByText(workflowId, { exact: false })).toBeVisible();
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
      name: `Remove filter Workflow: ${workflowId}`,
    }),
  ).toBeVisible();
});
