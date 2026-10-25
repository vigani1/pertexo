import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from '../../support/fixtures';
import { openWorkflowAction } from '../actions';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  currentEtag,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
} from '../support';

async function measureHeader(page: Page) {
  const header = page.locator('header');
  expect((await header.boundingBox())?.height).toBeLessThanOrEqual(190);
  const controls = [
    header,
    header.getByRole('status'),
    header.getByRole('navigation', { name: 'Workflow sections' }),
    header.getByRole('button', {
      name:
        (page.viewportSize()?.width ?? 1280) < 640
          ? 'More workflow actions'
          : 'Workflow contract',
      exact: true,
    }),
    header.getByRole('button', { name: /^(Publish v|No changes since v)/u }),
    header.locator('#editor-issues-chip'),
  ];
  return Promise.all(
    controls.map(async (control) => {
      const box = await control.boundingBox();
      if (box === null) throw new Error('Header control is not visible');
      return box;
    }),
  );
}
async function expectSameHeader(
  page: Page,
  baseline: Awaited<ReturnType<typeof measureHeader>>,
) {
  const current = await measureHeader(page);
  for (const [index, box] of current.entries()) {
    const before = baseline[index];
    if (before === undefined) throw new Error('Missing header baseline');
    for (const key of ['x', 'y', 'width', 'height'] as const)
      expect(Math.abs(box[key] - before[key])).toBeLessThan(1);
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
}
async function openStep(page: Page, width: number) {
  await page.getByTestId('rf__node-target').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}
async function exerciseSaveStates(
  page: Page,
  context: BrowserContext,
  width: number,
) {
  await page.setViewportSize({ width, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.route('**/v1/workspaces/*/workflows/*/presence**', (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ json: { accepted: true } })
      : route.fulfill({
          json: {
            people: [
              {
                userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                displayName: 'Discussion owner',
                editing: true,
                dirty: true,
                baseRevision: 1,
                tabCount: 1,
              },
            ],
          },
        }),
  );
  let mode: 'held-failure' | 'uncertain' | 'pass' = 'held-failure';
  let finishFailure!: () => Promise<void>;
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    async (route) => {
      if (mode === 'uncertain') return route.abort('failed');
      if (mode !== 'held-failure' || route.request().method() === 'GET')
        return route.fallback();
      await new Promise<void>((resolve) => {
        finishFailure = async () => {
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            json: {
              type: 'urn:pertexo:problem:internal.unexpected',
              title: 'Save unavailable',
              status: 503,
              code: 'internal.unexpected',
              requestId: 'header-save-outage',
            },
          });
          resolve();
        };
      });
    },
  );
  await page.goto(editorUrl);
  const header = page.locator('header');
  const status = header.getByRole('status');
  await expect(status).toContainText('Saved');
  await openStep(page, width);
  const baseline = await measureHeader(page);
  await page.getByLabel('Label', { exact: true }).fill('Header edit');
  await expect(status).toContainText('Unsaved');
  await expectSameHeader(page, baseline);
  await expect(status).toContainText('Saving…');
  await expectSameHeader(page, baseline);
  await expect.poll(() => typeof finishFailure).toBe('function');
  await finishFailure();
  await expect(status).toContainText('Couldn’t save');
  await expectSameHeader(page, baseline);
  mode = 'uncertain';
  await header.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toContainText('Save unconfirmed');
  await expectSameHeader(page, baseline);
  mode = 'pass';
  await header.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(status).toContainText('Saved');
  await expectSameHeader(page, baseline);
  remote.revision += 1;
  await page.getByLabel('Label', { exact: true }).fill('Conflicting edit');
  await expect(status).toContainText('Changed elsewhere');
  await expectSameHeader(page, baseline);
  await header.getByRole('button', { name: 'Review', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: 'Your copy and theirs' }),
  ).toBeVisible();
  await page.screenshot({
    path: `/tmp/pertexo-polish-9-conflict-${String(width)}.png`,
  });
}
for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [320, 360, 375, 390, 768, 1024, 1280, 1440, 1536, 1920]) {
    test(`keeps save states and recovery controls stationary at ${String(width)}px in ${colorScheme}`, async ({
      page,
      context,
    }) => {
      await page.emulateMedia({ colorScheme });
      await exerciseSaveStates(page, context, width);
    });
  }
}
test.describe('touch header', () => {
  test.use({ hasTouch: true });
  test('keeps the phone save and recovery layout stationary with touch targets', async ({
    page,
    context,
  }) => {
    await exerciseSaveStates(page, context, 390);
  });
});
for (const width of [390, 1280]) {
  test(`groups Contract and links Starting to Triggers at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = remoteDraft(mappingGraph());
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    const versionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`;
    await page.route(root, (route) =>
      route.fulfill({
        json: {
          workflow: {
            ...workflowSummary('Order intake', versionId).workflow,
            activationStatus: 'activating',
          },
        },
      }),
    );
    await page.route(`${root}/versions?**`, (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: versionId,
              workflowId,
              versionNumber: 1,
              graph: remote.graph,
              checksum: `wf:sha256:${'a'.repeat(64)}`,
              publishedAt: '2026-09-14T10:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route(`${root}/validate`, (route) =>
      route.fulfill({
        json: {
          valid: true,
          issues: [],
          currentPublication: {
            versionId,
            versionNumber: 1,
            matchesDraft: remote.revision === 1,
          },
          compatibility: {
            compatible: true,
            fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
            issues: [],
          },
        },
        headers: { etag: currentEtag(remote) },
      }),
    );
    await page.goto(editorUrl);
    const header = page.locator('header');
    const starting = header.getByRole('link', {
      name: 'Starting — check triggers',
      exact: true,
    });
    await expect(starting).toHaveAttribute('href', `${editorUrl}/triggers`);
    await starting.focus();
    await expect(starting).toBeFocused();
    await expect(
      header.getByRole('link', { name: 'Check triggers', exact: true }),
    ).toHaveCount(0);
    await openWorkflowAction(page, 'Workflow contract');
    const contract = page.getByRole('dialog', {
      name: 'Workflow contract',
      exact: true,
    });
    await expect(contract).toBeVisible();
    await contract.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(contract).not.toBeVisible();
    await expect(
      header.getByRole('button', {
        name: width < 640 ? 'More workflow actions' : 'Workflow contract',
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      header.getByRole('button', { name: 'No changes since v1', exact: true }),
    ).toBeDisabled();
    await openStep(page, width);
    const baseline = await measureHeader(page);
    await page
      .getByLabel('Value', { exact: true })
      .fill('Changed since publication');
    await expect(
      header.getByRole('button', { name: 'Publish v2', exact: true }),
    ).toBeVisible();
    await expectSameHeader(page, baseline);
    await expect.poll(() => remote.revision).toBe(2);
    await expectSameHeader(page, baseline);
    await page.screenshot({
      path: `/tmp/pertexo-polish-9-after-${String(width)}.png`,
    });
  });
}
