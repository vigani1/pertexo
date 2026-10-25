import { expect, test } from '../../../support/fixtures';

import { addStep } from '../../actions';
import { editorNode, mappingGraph } from '../../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
  user,
  workflowId,
  workspace,
  workspaceId,
} from '../../support';

import {
  expectHeaderActions,
  expectHeaderBounds,
  expectWorkflowSections,
} from './fixture';

test('confirms leaving a dirty editor before revoking the session', async ({
  context,
  page,
}) => {
  const remote = remoteDraft({
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
    .getByRole('button', { name: 'Step', exact: true })
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

  for (const width of [390, 720, 1024, 1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const panels = page.getByRole('navigation', { name: 'Editor panels' });
    const canvas = page.getByRole('region', { name: 'Workflow canvas' });
    const bar = page
      .locator('header')
      .filter({ has: page.getByRole('link', { name: 'Back to workflows' }) });
    const barBox = await bar.boundingBox();
    await expectHeaderActions(page, bar, width);
    await expectWorkflowSections(bar, width);
    await expectHeaderBounds(bar, {
      width,
      longWorkflowName,
      barHeight: barBox?.height,
    });
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
    // Arrive by keyboard so :focus-visible applies after earlier clicks.
    await zoomIn.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
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
  // A read-only actor can still open an input to read how it's set up.
  await inputs.getByRole('button', { name: /^customer from/u }).click();
  await expect(inputs.getByLabel('Field', { exact: true })).toBeDisabled();
  await expect(inputs.getByLabel('JSON value', { exact: true })).toBeDisabled();
  expect(remote.revision).toBe(1);
});

for (const width of [1280, 390]) {
  test(`palette links forward from the selected step at ${String(width)}px`, async ({
    page,
    context,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = remoteDraft(mappingGraph());
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width < 640)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await addStep(page, /Set fields/u).click();
    await expect.poll(() => remote.graph.nodes.length).toBe(3);
    const added = remote.graph.nodes.at(-1) as {
      id: string;
      position: { x: number; y: number };
    };
    expect(added.position.x).toBeGreaterThan(340 + 224);
    expect(remote.graph.edges.at(-1)).toMatchObject({
      source: { nodeId: 'target', port: 'out' },
      target: { nodeId: added.id, port: 'in' },
    });
    await expect(page.getByTestId(`rf__node-${added.id}`)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`selected-step-${String(width)}.png`),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByTestId(`rf__node-${added.id}`)).toBeVisible();
    expect(remote.graph.edges).toHaveLength(2);
  });
}

test('palette leaves a multiple selection unlinked', async ({
  page,
  context,
}) => {
  const remote = remoteDraft(mappingGraph());
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, {
    definitions: [manualDefinition, definition],
  });
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-manual').click();
  await page
    .getByTestId('rf__node-target')
    .click({ modifiers: ['ControlOrMeta'] });
  await expect(
    page.getByRole('toolbar', { name: 'Canvas selection' }),
  ).toContainText('2 steps');
  await addStep(page, /Set fields/u).click();
  await expect.poll(() => remote.graph.nodes.length).toBe(3);
  expect(remote.graph.edges).toHaveLength(1);
});
