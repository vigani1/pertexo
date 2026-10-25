import { expect, type Locator, type Page } from '@playwright/test';
import { uncoveredArea } from '../../../src/features/workflow-editor/model/canvas/framing';
import { test } from '../../support/browser-fixture';
async function expectUnobstructedControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        if (
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          bounds.left < 0 ||
          bounds.top < 0 ||
          bounds.right > window.innerWidth ||
          bounds.bottom > window.innerHeight
        )
          return false;
        // Test both the label/icon and inset corners. A covering lens must not
        // make a button appear usable solely because focus can reach it.
        const insetX = Math.min(4, bounds.width / 4);
        const insetY = Math.min(4, bounds.height / 4);
        return [
          [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2],
          [bounds.left + insetX, bounds.top + insetY],
          [bounds.right - insetX, bounds.bottom - insetY],
        ].every(([x, y]) => {
          if (x === undefined || y === undefined) return false;
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === element || element.contains(hit));
        });
      }),
    )
    .toBe(true);
}

function canvasCoverage(element: Element) {
  const box = element.getBoundingClientRect();
  return {
    canvas: {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    },
    covers: [...document.querySelectorAll('[data-canvas-cover]')].map(
      (cover) => {
        const bounds = cover.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
        };
      },
    ),
  };
}

export async function inspectViewerViewport(
  viewer: Page,
  {
    width,
    workspaceId,
    workflowId,
    nodeId,
  }: Readonly<{
    width: number;
    workspaceId: string;
    workflowId: string;
    nodeId: string;
  }>,
) {
  await viewer.setViewportSize({ width, height: 900 });
  await viewer.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  await expect(viewer.getByTestId(`rf__node-${nodeId}`)).toBeVisible();
  await expect(
    viewer.getByRole('complementary', { name: 'Add a step' }),
  ).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: /^Publish/u })).toHaveCount(
    0,
  );
  await expect(
    viewer.getByRole('button', { name: 'Run', exact: true }),
  ).toHaveCount(0);
  const node = viewer.getByTestId(`rf__node-${nodeId}`);
  await node.focus();
  await expect(node).toBeFocused();
  await viewer.keyboard.press('Enter');
  if (width < 1024)
    await viewer
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
  if (width < 1024) {
    const panels = viewer.getByRole('navigation', {
      name: 'Editor panels',
    });
    for (const name of ['Canvas', 'Step'])
      await expectUnobstructedControl(
        panels.getByRole('button', { name, exact: true }),
      );
  }
  const label = viewer.getByLabel('Label', { exact: true });
  await expect(label).toBeVisible();
  await expect(label).toBeDisabled();
  const labelBounds = await label.boundingBox();
  expect(labelBounds?.width).toBeGreaterThan(150);
  expect(labelBounds?.x).toBeGreaterThanOrEqual(0);
  expect((labelBounds?.x ?? 0) + (labelBounds?.width ?? 0)).toBeLessThanOrEqual(
    width,
  );
  if (width >= 640) {
    await expect(
      viewer.getByRole('button', { name: 'Undo', exact: true }),
    ).toBeDisabled();
    await expect(
      viewer.getByRole('button', { name: 'Redo', exact: true }),
    ).toBeDisabled();
  } else {
    await viewer
      .getByRole('button', { name: 'More workflow actions', exact: true })
      .click();
    await expect(
      viewer.getByRole('menuitem', { name: /^Undo/u }),
    ).toHaveAttribute('aria-disabled', 'true');
    await expect(
      viewer.getByRole('menuitem', { name: /^Redo/u }),
    ).toHaveAttribute('aria-disabled', 'true');
    await viewer.keyboard.press('Escape');
  }
  const inputsTab = viewer.getByRole('tab', {
    name: 'Inputs',
    exact: true,
  });
  await inputsTab.focus();
  await viewer.keyboard.press('Enter');
  const inputs = viewer.getByRole('region', {
    name: 'Inputs',
    exact: true,
  });
  await expect(
    inputs.getByRole('button', { name: 'Add input', exact: true }),
  ).toHaveCount(0);
  await inputs.getByRole('button', { name: /^proof from/u }).click();
  await expect(inputs.getByLabel('Field', { exact: true })).toBeDisabled();
  await expect(
    inputs.getByLabel('Run input path', { exact: true }),
  ).toBeDisabled();
  await viewer.screenshot({
    path: test.info().outputPath(`readonly-${String(width)}-inspector.png`),
  });
  const canvas = viewer.getByRole('region', {
    name: 'Workflow canvas',
    exact: true,
  });
  if (width >= 1024) {
    const visible = await canvas.evaluate(canvasCoverage);
    expect(
      uncoveredArea(visible.canvas, visible.covers).width,
    ).toBeGreaterThanOrEqual(500);
  }
  await viewer
    .getByRole('button', { name: 'Close step panel', exact: true })
    .click();
  if (width < 1024) {
    const panels = viewer.getByRole('navigation', {
      name: 'Editor panels',
    });
    for (const name of ['Canvas', 'Step']) {
      const button = panels.getByRole('button', { name, exact: true });
      await expectUnobstructedControl(button);
      await button.focus();
      await expect(button).toBeFocused();
    }
  }
  const available = await canvas.evaluate(canvasCoverage);
  const area = uncoveredArea(available.canvas, available.covers);
  expect(area.width).toBeGreaterThanOrEqual(300);
  expect(area.height).toBeGreaterThanOrEqual(300);
  for (const name of ['Zoom in', 'Zoom out', 'Fit workflow to screen']) {
    const button = viewer.getByRole('button', { name, exact: true });
    await expectUnobstructedControl(button);
    await button.focus();
    await expect(button).toBeFocused();
    await viewer.keyboard.press('Enter');
  }
  await expect
    .poll(async () => {
      const box = await node.boundingBox();
      return (
        box !== null &&
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= width &&
        box.y + box.height <= 900
      );
    })
    .toBe(true);
  await viewer.screenshot({
    path: test.info().outputPath(`readonly-${String(width)}-canvas.png`),
  });
}
