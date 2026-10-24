import {
  createUserFixture,
  createWorkspaceFixture,
} from '../test/support/fixtures/identity';
import { expect, test, type Page } from './support/fixtures';

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
  status: 'failed' | 'succeeded' | 'outcome_unknown',
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
      json: createUserFixture({
        id: userId,
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
            role: 'viewer',
            capabilities: [
              'workspace:read',
              'workflow:read',
              'run:read',
              'run:replay',
            ],
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
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
    webhookSetupRequired: false,
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
  await page.route(`**/v1/workspaces/${workspaceId}/runs/*/input`, (route) =>
    route.fulfill({
      json: { input: { kind: 'inline', value: { incident: 'INC-41' } } },
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
              graph: { nodes: [], edges: [], settings: {} },
              checksum:
                'wf:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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

test('replays the exact displayed version from its own input', async ({
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
  await expect(dialog.getByText(/with this run’s input/u)).toBeVisible();
  const input = dialog.getByLabel('Replay input (JSON)');
  await expect(input).toHaveValue(/"incident": "INC-41"/u);
  await input.fill('{"incident":"INC-42"}');
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

for (const width of [1280, 375])
  test(`shows bounded error-workflow capacity waiting and its refusal at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    let status: 'pending' | 'refused' = 'pending';
    const deadline = new Date(Date.now() + 15 * 60_000).toISOString();
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: run(firstRunId, 'failed'),
            nodes: [],
            errorWorkflow: {
              status,
              targetWorkflowId: workflowId,
              targetVersionId: workflowVersionId,
              acceptedRunId: null,
              queueWaitExpiresAt: deadline,
              refusalCode: status === 'pending' ? null : 'queue_full',
            },
          },
        }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    await expect(
      page.getByText('Error workflow is waiting for queue capacity', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/^Retries until /u)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`queue-wait-${String(width)}.png`),
      fullPage: true,
    });
    status = 'refused';
    await expect(
      page.getByText('Error workflow did not start', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/15-minute wait for queue capacity expired/u),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Failed after 2s', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`queue-refused-${String(width)}.png`),
      fullPage: true,
    });
  });

for (const width of [1280, 375])
  for (const risk of ['possible_effects', 'unknown_outcome'] as const)
    test(`confirms ${risk} saved-result recovery and shows reused history at ${String(width)}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 768 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.context().addCookies([
        {
          name: 'pertexo_csrf',
          value: csrfToken,
          url: 'http://127.0.0.1:4173',
        },
      ]);
      await installRoutes(page);
      const targetId = '22222222-2222-4222-8222-222222222222';
      const copyId = '33333333-3333-4333-8333-333333333333';
      const sourceCopyId = '44444444-4444-4444-8444-444444444444';
      const newTargetId = '55555555-5555-4555-8555-555555555555';
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: run(
                firstRunId,
                risk === 'unknown_outcome' ? 'outcome_unknown' : 'failed',
              ),
              nodes: [],
            },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/recovery`,
        (route) =>
          route.fulfill({
            json: {
              kind: 'eligible',
              workflowVersionId,
              versionNumber: 1,
              nodeRunId: targetId,
              nodeId: 'http',
              nodeLabel: 'Send request',
              reusedCount: 1,
              sourceCompletedAt: timestamp,
              effectRisk: risk,
            },
          }),
      );
      let posted: unknown;
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/recover`,
        (route) => {
          posted = route.request().postDataJSON();
          const { workflowName: _, ...accepted } = run(
            replayRunId,
            'succeeded',
          );
          return route.fulfill({
            status: 202,
            json: { run: accepted, replayed: false },
          });
        },
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${replayRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: {
                ...run(replayRunId, 'succeeded'),
                triggerType: 'replay',
                replaySourceRunId: firstRunId,
                recovery: {
                  targetNodeRunId: targetId,
                  targetNodeId: 'http',
                  reusedCount: 1,
                  effectRisk: risk,
                  effectsAcknowledged: true,
                },
              },
              nodes: [
                {
                  id: copyId,
                  nodeId: 'manual',
                  invocationKey: 'manual:0',
                  status: 'succeeded',
                  currentAttemptNumber: 0,
                  startedAt: null,
                  completedAt: null,
                  resumeAt: null,
                  safeErrorCode: null,
                  reused: {
                    sourceRunId: firstRunId,
                    sourceNodeRunId: sourceCopyId,
                    sourceCompletedAt: timestamp,
                  },
                },
                {
                  id: newTargetId,
                  nodeId: 'http',
                  invocationKey: 'http:0',
                  status: 'succeeded',
                  currentAttemptNumber: 1,
                  startedAt: timestamp,
                  completedAt: '2026-09-15T10:00:02.000Z',
                  resumeAt: null,
                  safeErrorCode: null,
                },
              ],
            },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${replayRunId}/node-runs/${copyId}/output`,
        (route) =>
          route.fulfill({ json: { output: { kind: 'inline', value: {} } } }),
      );
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await page
        .getByRole('button', { name: 'Retry from this step', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Retry from this step' });
      const ack = dialog.getByRole('checkbox');
      await expect(ack).not.toBeChecked();
      const confirm = dialog.getByRole('button', { name: 'Retry anyway' });
      await expect(confirm).toBeDisabled();
      await expect(dialog).toContainText(
        'Earlier steps use their saved results',
      );
      if (risk === 'unknown_outcome')
        await expect(dialog).toContainText(
          "We don't know whether this step reached the service. Retrying can repeat its effect.",
        );
      await ack.focus();
      await page.keyboard.press('Space');
      await expect(confirm).toBeEnabled();
      const box = await dialog.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/recovery-confirmation-${risk}-${String(width)}.png`,
          fullPage: true,
        });
      await testInfo.attach(`recovery-confirmation-${risk}-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      await confirm.click();
      await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
      expect(posted).toEqual({
        workflowVersionId,
        nodeRunId: targetId,
        ...(risk === 'unknown_outcome'
          ? { acknowledgeUnknownOutcome: true }
          : { acknowledgePossibleEffects: true }),
      });
      await expect(page.getByText('1 earlier step reused')).toBeVisible();
      await expect(
        width < 640
          ? page.getByRole('button', { name: 'manual: Reused', exact: true })
          : page.getByText('Reused', { exact: true }).first(),
      ).toBeVisible();
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/recovery-run-${risk}-${String(width)}.png`,
          fullPage: true,
        });
      await testInfo.attach(`recovery-run-${risk}-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });

for (const width of [1280, 375])
  test(`keeps handled failures visibly failed in successful history at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    const source = {
      id: '22222222-2222-4222-8222-222222222222',
      nodeId: 'source',
      invocationKey: 'source:0',
      status: 'failed',
      currentAttemptNumber: 1,
      startedAt: timestamp,
      completedAt: '2026-09-15T10:00:01.000Z',
      resumeAt: null,
      safeErrorCode: 'execution.authentication',
      failureHandling: {
        entryInvocationKey: 'handler:0',
        sinkInvocationKey: 'handler:0',
        disposition: 'handled',
      },
    };
    const handler = {
      ...source,
      id: '33333333-3333-4333-8333-333333333333',
      nodeId: 'handler',
      invocationKey: 'handler:0',
      status: 'succeeded',
      safeErrorCode: null,
    };
    const { failureHandling: _, ...ordinaryHandler } = handler;
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: { ...run(firstRunId, 'succeeded'), handledFailureCount: 1 },
            nodes: [source, ordinaryHandler],
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/input`,
      (route) => route.fulfill({ json: { input: { kind: 'none' } } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/output`,
      (route) => route.fulfill({ json: { output: { kind: 'none' } } }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    await expect(
      page.getByText('Finished — 1 failure handled', { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: /source: Failed · failure handled/u })
      .click();
    const details =
      width < 640 ? page.getByRole('dialog') : page.getByLabel('Step details');
    await expect(details).toContainText(
      'The selected handler finished successfully. This source step remains failed.',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
      await page.screenshot({
        path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/failure-history-${String(width)}.png`,
        fullPage: true,
      });
    await testInfo.attach(`handled-failure-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });

for (const width of [1280, 375])
  test(`pages large loop and Call histories at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: run(firstRunId, 'succeeded'),
            nodes: Array.from({ length: 2_501 }, (_, index) => ({
              id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
              nodeId: 'item',
              invocationKey: `item-${String(index).padStart(4, '0')}`,
              status: 'succeeded',
              currentAttemptNumber: 1,
              startedAt: timestamp,
              completedAt: '2026-09-15T10:00:01.000Z',
              resumeAt: null,
              safeErrorCode: null,
            })),
            calls: Array.from({ length: 2_499 }, (_, index) => ({
              id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
              invocationKey: `call-${String(index)}`,
              targetWorkflowId: workflowId,
              targetVersionId: workflowVersionId,
              childRunId: secondRunId,
              childHistory: 'retained',
              status: 'succeeded',
              slotLent: false,
              detailsRetired: false,
              safeErrorCode: null,
            })),
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/input`,
      (route) => route.fulfill({ json: { input: { kind: 'none' } } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/output`,
      (route) => route.fulfill({ json: { output: { kind: 'none' } } }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    const steps = page.getByRole('navigation', { name: 'Step history pages' });
    await expect(steps).toHaveText(/2,501–2,501 of 2,501/u);
    await expect(page.getByRole('button', { name: /^item/u })).toHaveCount(1);
    await steps.getByRole('button', { name: 'Previous' }).click();
    await expect(steps).toHaveText(/2,451–2,500 of 2,501/u);
    await expect(page.getByRole('button', { name: /^item/u })).toHaveCount(50);
    const calls = page.getByRole('navigation', {
      name: 'Called workflow pages',
    });
    await expect(calls).toHaveText(/1–50 of 2,499/u);
    await expect(
      page.getByRole('link', { name: 'Open child run' }),
    ).toHaveCount(50);
    await calls.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Call 51', { exact: true })).toBeVisible();
    await expect(calls).toHaveText(/51–100 of 2,499/u);
    await page.getByRole('tab', { name: 'Input & output' }).click();
    const results = page.getByRole('navigation', { name: 'Step result pages' });
    await expect(results).toHaveText(/2,501–2,501 of 2,501/u);
    await results.getByRole('button', { name: 'Previous' }).click();
    await expect(results).toHaveText(/2,451–2,500 of 2,501/u);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
      await page.screenshot({
        path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/loop-history-${String(width)}.png`,
        fullPage: false,
      });
    await testInfo.attach(`loop-history-${String(width)}`, {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  });

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`finds exact business values and reads their run in ${theme} at ${String(width)}px`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await installRoutes(page);
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: {
                ...run(firstRunId, 'succeeded'),
                runValues: { orderId: 'A-1042', empty: '' },
              },
              nodes: [],
            },
          }),
      );
      await page.goto(`/w/${workspaceId}/runs`);
      await page.getByRole('button', { name: 'Run value: any' }).click();
      const valueFilter = page.getByRole('dialog', {
        name: 'Find runs by a saved value',
      });
      await valueFilter.getByLabel('Name', { exact: true }).fill('orderId');
      await valueFilter.getByLabel('Value', { exact: true }).fill('A-1042');
      const request = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return (
          url.pathname.endsWith('/runs') &&
          url.searchParams.get('runValueKey') === 'orderId' &&
          url.searchParams.get('runValue') === 'A-1042'
        );
      });
      await valueFilter.getByRole('button', { name: 'Find runs' }).click();
      await request;
      await expect(page).toHaveURL(/runValueKey=orderId/);
      await expect(
        page.getByRole('button', { name: 'Remove filter orderId = A-1042' }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`run-value-filter-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await expect(
        page.getByText('Saved run values', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('A-1042', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Copy orderId' }),
      ).toBeVisible();
      await expect(page.getByText('Empty text', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(
          `run-values-detail-${theme}-${String(width)}.png`,
        ),
        fullPage: true,
      });
    });
