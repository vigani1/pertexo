import { expect, test } from '@playwright/test';
import {
  addCsrfCookie,
  addStep,
  blocksUnload,
  definition,
  editorNode,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  mappingGraph,
  remoteDraft,
  user,
  workflowId,
  workflowSummary,
  workspace,
  workspaceId,
} from './workflow-editor-support';

test('edits typed input mappings live, saves them and restores rendered controls after reload', async ({
  context,
  page,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await expect(
    page.getByRole('heading', { name: 'Customer onboarding' }),
  ).toBeVisible();
  await page.getByTestId('rf__node-target').click();
  await page.getByRole('tab', { name: 'Inputs' }).click();
  const inputs = page.getByRole('region', { name: 'Inputs' });
  const rows = inputs.getByRole('listitem');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(0).getByLabel('Field', { exact: true }).fill('customer');
  await rows.nth(0).getByRole('button', { name: 'Step output' }).click();
  await rows
    .nth(0)
    .getByLabel('Output path', { exact: true })
    .fill('$.customer');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(1).getByLabel('Field', { exact: true }).fill('requestedBy');
  await rows.nth(1).getByRole('button', { name: 'Run input' }).click();
  await rows
    .nth(1)
    .getByLabel('Run input path', { exact: true })
    .fill('$.actor.name');

  await inputs.getByRole('button', { name: 'Add input' }).click();
  await rows.nth(2).getByLabel('Field', { exact: true }).fill('payload');
  await rows
    .nth(2)
    .getByLabel('JSON value', { exact: true })
    .fill('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}');
  await expect
    .poll(() => JSON.stringify(remote.graph), { timeout: 6_000 })
    .toContain(
      '"payload":{"kind":"literal","value":{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}}',
    );
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph.nodes[1]).toMatchObject({
    inputMappings: {
      customer: { kind: 'node_output', nodeId: 'manual', path: '$.customer' },
      requestedBy: { kind: 'run_input', path: '$.actor.name' },
      payload: { kind: 'literal' },
    },
  });

  await page.reload();
  await page.getByTestId('rf__node-target').click();
  await page.getByRole('tab', { name: 'Inputs' }).click();
  const restored = page.getByRole('region', { name: 'Inputs' });
  await expect(restored.getByRole('listitem')).toHaveCount(3);
  await expect(
    restored.getByRole('listitem').nth(0).getByLabel('Field', { exact: true }),
  ).toHaveValue('customer');
  await expect(
    restored
      .getByRole('listitem')
      .nth(0)
      .getByLabel('Output path', { exact: true }),
  ).toHaveValue('$.customer');
  const restoredLiteral = await restored
    .getByRole('listitem')
    .nth(2)
    .getByLabel('JSON value', { exact: true })
    .inputValue();
  expect(JSON.parse(restoredLiteral)).toEqual(
    JSON.parse('{"__proto__":{"x":1},"normal":2,"nested":[{"__proto__":3}]}'),
  );
});

test('edits, autosaves, and preserves both drafts during a two-tab conflict', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  const second = await context.newPage();
  await installEditorRoutes(page, remote);
  await installEditorRoutes(second, remote);
  await Promise.all([page.goto(editorUrl), second.goto(editorUrl)]);
  await addStep(page, /Set fields/u).click();
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect
    .poll(() => remote.graph.nodes.length, { timeout: 4_000 })
    .toBe(1);
  await expect(page.getByText(/^Saved/u)).toBeVisible();
  await page.reload();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);

  await addStep(second, /Set fields/u).click();
  const conflict = second.getByRole('region', { name: 'Draft conflict' });
  await expect(conflict).toContainText('Changed elsewhere (revision 2)', {
    timeout: 4_000,
  });
  await conflict.getByRole('button', { name: 'Compare' }).click();
  await second.getByRole('tab', { name: 'JSON' }).click();
  await expect(second.getByText(/1 step, 0 connections/u)).toHaveCount(2);
  await second.getByRole('button', { name: 'Close' }).click();
  await conflict.getByRole('button', { name: 'Keep mine' }).click();
  await expect(conflict).toContainText('Your copy is kept for comparison');
  await expect(second.getByText(/^Saved/u)).toBeVisible();
  expect(remote.graph.nodes).toHaveLength(1);
  expect(remote.revision).toBe(2);

  await addStep(second, /Set fields/u).click();
  await expect(second.getByText('Unsaved')).toBeVisible();
  await expect.poll(() => remote.graph.nodes.length).toBe(2);
  expect(remote.revision).toBe(3);
  await expect(conflict).toBeVisible();
  expect(await blocksUnload(second)).toBe(true);
  await second.getByRole('link', { name: 'Settings' }).click();
  await expect(
    second.getByRole('heading', { name: 'Discard your kept copy?' }),
  ).toBeVisible();
  await expect(second).toHaveURL(editorUrl);
  await second.getByRole('button', { name: 'Stay here' }).click();
  await conflict.getByRole('button', { name: 'Dismiss copy' }).click();
  await expect(conflict).toBeHidden();
  expect(await blocksUnload(second)).toBe(false);
  await second.getByRole('link', { name: 'Back to workflows' }).click();
  await expect(second).toHaveURL(`/w/${workspaceId}/workflows`);
});

test('keeps keyboard placement usable and the narrow editor horizontally bounded', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(editorUrl);
  const panels = page.getByRole('navigation', { name: 'Editor panels' });
  await expect(panels).toBeVisible();
  const canvas = page.getByRole('region', { name: 'Workflow canvas' });
  await expect(canvas).toBeVisible();
  await panels.getByRole('button', { name: 'Add step' }).focus();
  await page.keyboard.press('Enter');
  const add = addStep(page, /Set fields/u);
  await expect(add).toBeVisible();
  await add.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Unsaved')).toBeVisible();
  await expect(page.getByText(/^Saved/u)).toBeVisible({ timeout: 4_000 });
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox?.width).toBeGreaterThan(360);
  expect(canvasBox?.height).toBeGreaterThan(500);
  await page.locator('.react-flow__node').click();
  await panels.getByRole('button', { name: 'Step' }).click();
  await page.getByLabel('Label', { exact: true }).fill('Mobile scratch');
  await panels.getByRole('button', { name: 'Canvas' }).click();
  await panels.getByRole('button', { name: 'Step' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Mobile scratch',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test('keeps workflow identity bounded at 320 and 390 pixels once metadata loads', async ({
  context,
  page,
}) => {
  const remote = remoteDraft();
  let metadataAvailable = false;
  const longName = 'W'.repeat(128);
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
    (route) =>
      metadataAvailable
        ? route.fulfill({ json: workflowSummary(longName) })
        : route.fulfill({ status: 500, json: {} }),
  );

  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(editorUrl);
  await expect(page.getByRole('heading', { name: 'Workflow' })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Workflow canvas' }),
  ).toBeVisible();

  metadataAvailable = true;
  await page.reload();
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const identity = page.getByRole('heading', { name: longName });
    await expect(identity).toBeVisible();
    const box = await identity.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    const canvasBox = await page
      .getByRole('region', { name: 'Workflow canvas' })
      .boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width - 30);
    expect(canvasBox?.height).toBeGreaterThan(400);
  }
});

test('confirms leaving a dirty editor before revoking the session', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [editorNode('node-a', 'Original label', 'value', 80)],
    edges: [],
    settings: {},
  });
  let logoutRequests = 0;
  let signedOut = false;
  let releaseSave: (() => void) | undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote);
  await page.route('**/v1/users/me', (route) =>
    signedOut
      ? route.fulfill({
          status: 401,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            type: 'https://pertexo.test/problems/auth.unauthenticated',
            title: 'Authentication required',
            status: 401,
            code: 'auth.unauthenticated',
            requestId: 'request-logout-ordering',
          }),
        })
      : route.fulfill({ json: user }),
  );
  await page.route('**/v1/auth/logout', async (route) => {
    logoutRequests += 1;
    signedOut = true;
    await route.fulfill({ status: 204 });
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
    async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      await saveGate;
      await route.fallback();
    },
  );

  await page.goto(editorUrl);
  await page.getByTestId('rf__node-node-a').click();
  await page.getByLabel('Label', { exact: true }).fill('Unsaved logout edit');
  const back = page.getByRole('link', { name: 'Back to workflows' });
  await back.click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unsaved changes?' }),
  ).toBeVisible();
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: 'Stay here' }).click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Unsaved logout edit',
  );
  await expect(page).toHaveURL(editorUrl);

  await page.setViewportSize({ width: 390, height: 844 });
  await back.click();
  await expect(
    page.getByRole('heading', { name: 'Leave with unsaved changes?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Stay here' }).click();
  await page
    .getByRole('navigation', { name: 'Editor panels' })
    .getByRole('button', { name: 'Step' })
    .click();
  await expect(page.getByLabel('Label', { exact: true })).toHaveValue(
    'Unsaved logout edit',
  );

  await back.click();
  await page.getByRole('button', { name: 'Leave anyway' }).click();
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  expect(logoutRequests).toBe(0);
  await page.getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('dialog', { name: 'More' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect.poll(() => logoutRequests).toBe(1);
  await expect(page).toHaveURL(/\/login$/u);
  releaseSave?.();
});

test('floats the lenses over a full canvas across responsive layouts', async ({
  context,
  page,
}, testInfo) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [editorNode('node-a', 'Selected node', 'value', 80)],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  const longWorkflowName =
    'Customer onboarding and account provisioning across regional operations';
  await installEditorRoutes(page, remote, { workflowName: longWorkflowName });
  await page.goto(editorUrl);
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toHaveCount(
    0,
  );
  await page.getByTestId('rf__node-node-a').click();

  for (const width of [390, 720, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const panels = page.getByRole('navigation', { name: 'Editor panels' });
    const canvas = page.getByRole('region', { name: 'Workflow canvas' });
    const bar = page
      .locator('header')
      .filter({ has: page.getByRole('link', { name: 'Back to workflows' }) });
    const barBox = await bar.boundingBox();
    if (width === 1440) expect(barBox?.height).toBeLessThanOrEqual(64);
    if (width === 390) expect(barBox?.height).toBeLessThanOrEqual(200);
    const heading = bar.getByRole('heading', { name: longWorkflowName });
    const headingBox = await heading.boundingBox();
    expect((headingBox?.x ?? 0) + (headingBox?.width ?? 0)).toBeLessThanOrEqual(
      width,
    );
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width - 30);
    const stepPanel = page.getByRole('complementary', { name: 'Step panel' });
    if (width < 1024) {
      await expect(panels).toBeVisible();
      await expect(stepPanel).toBeHidden();
    } else {
      await expect(panels).toBeHidden();
      await expect(stepPanel).toBeVisible();
      const panelBox = await stepPanel.boundingBox();
      expect((panelBox?.x ?? 0) + (panelBox?.width ?? 0)).toBeLessThanOrEqual(
        width,
      );
      expect(panelBox?.width).toBeLessThanOrEqual(345);
    }
    if (width === 390)
      await expect(canvas.locator('.react-flow__minimap')).toBeHidden();
    else await expect(canvas.locator('.react-flow__minimap')).toBeVisible();
    const zoomIn = page.getByRole('button', { name: 'Zoom in' });
    await zoomIn.focus();
    const zoomFocus = await zoomIn.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        active: document.activeElement === element,
        outline: style.outlineStyle,
        shadow: style.boxShadow,
      };
    });
    expect(zoomFocus.active).toBe(true);
    expect(zoomFocus.outline !== 'none' || zoomFocus.shadow !== 'none').toBe(
      true,
    );
    if (width === 390 || width === 720 || width === 1440) {
      const evidenceName =
        width === 720
          ? 'editor-200-percent-equivalent'
          : `editor-${String(width)}`;
      await testInfo.attach(evidenceName, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/${evidenceName}.png`,
          fullPage: true,
        });
    }
  }

  await page.emulateMedia({ forcedColors: 'active' });
  const backControl = page.getByRole('link', { name: 'Back to workflows' });
  await backControl.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(backControl).toBeFocused();
  const forcedFocus = await backControl.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  });
  expect(forcedFocus.outline !== 'none' || forcedFocus.shadow !== 'none').toBe(
    true,
  );
  await testInfo.attach('editor-forced-colors', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('gives a read-only actor the canvas and a read-only step panel', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
    schemaVersion: 1,
    nodes: [
      {
        ...editorNode('node-a', 'Read-only node', 'value', 80),
        inputMappings: {
          customer: { kind: 'literal', value: { retained: true } },
        },
      },
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read', 'connection:read'],
    },
  });
  await page.goto(editorUrl);

  await expect(
    page.getByRole('complementary', { name: 'Add a step' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Publish/u })).toHaveCount(0);
  for (const width of [390, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const canvasBox = await page
      .getByRole('region', { name: 'Workflow canvas' })
      .boundingBox();
    expect(canvasBox?.width).toBeGreaterThan(width - 30);
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
  }
  await page.getByTestId('rf__node-node-a').click();
  await page.getByRole('tab', { name: 'Inputs' }).click();
  const inputs = page.getByRole('region', { name: 'Inputs' });
  await expect(inputs.getByRole('button', { name: 'Add input' })).toHaveCount(
    0,
  );
  await expect(inputs.getByLabel('Field', { exact: true })).toBeDisabled();
  await expect(inputs.getByLabel('JSON value', { exact: true })).toBeDisabled();
  expect(remote.revision).toBe(1);
});
