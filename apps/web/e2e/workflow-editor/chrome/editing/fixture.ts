import type { Locator, Page } from '@playwright/test';
import { expect } from '../../../support/fixtures';
export async function expectHeaderActions(
  page: Page,
  bar: Locator,
  width: number,
) {
  const more = bar.getByRole('button', {
    name: 'More workflow actions',
    exact: true,
  });
  await more.click();
  const menu = page.getByRole('menu', {
    name: 'More workflow actions',
    exact: true,
  });
  await expect(
    menu.getByRole('menuitem', { name: 'Export…', exact: true }),
  ).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: 'Input cases', exact: true }),
  ).toBeVisible();
  await menu.press('Escape');
  await expect(menu).not.toBeVisible();
  for (const action of await bar.getByRole('button').all()) {
    if (!(await action.isVisible())) continue;
    const actionBox = await action.boundingBox();
    expect(actionBox).not.toBeNull();
    expect(actionBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((actionBox?.x ?? 0) + (actionBox?.width ?? 0)).toBeLessThanOrEqual(
      width,
    );
  }
}

export async function expectWorkflowSections(bar: Locator, width: number) {
  if (width === 1440 || width === 1920) {
    const tabs = await bar
      .getByRole('navigation', { name: 'Workflow sections' })
      .boundingBox();
    const publish = await bar
      .getByRole('button', { name: /^Publish/u })
      .boundingBox();
    if (tabs === null || publish === null)
      throw new Error('Workflow tabs and Publish must be visible');
    expect(tabs.y).toBeLessThan(publish.y + publish.height);
    expect(tabs.y + tabs.height).toBeGreaterThan(publish.y);
  }
}

export async function expectHeaderBounds(
  bar: Locator,
  {
    width,
    longWorkflowName,
    barHeight,
  }: Readonly<{
    width: number;
    longWorkflowName: string;
    barHeight: number | undefined;
  }>,
) {
  if (width === 390) expect(barHeight).toBeLessThanOrEqual(200);
  const publishBox = await bar
    .getByRole('button', { name: /^Publish/u })
    .boundingBox();
  expect((publishBox?.x ?? 0) + (publishBox?.width ?? 0)).toBeLessThanOrEqual(
    width,
  );
  const more = bar.getByRole('button', { name: 'More workflow actions' });
  await expect(more).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Undo' })).toBeHidden();
  const heading = bar.getByRole('heading', { name: longWorkflowName });
  const headingBox = await heading.boundingBox();
  expect((headingBox?.x ?? 0) + (headingBox?.width ?? 0)).toBeLessThanOrEqual(
    width,
  );
}

export async function expectCanvasBesideWorkspace(
  page: Page,
  canvas: Locator,
  width: number,
) {
  const canvasBox = await canvas.boundingBox();
  const workspaceNav = page.getByRole('navigation', { name: 'Workspace' });
  const navBox = await workspaceNav.boundingBox();
  expect(navBox).not.toBeNull();
  expect(canvasBox?.width).toBeGreaterThan(width - (width >= 768 ? 100 : 30));
  if (width >= 768) {
    expect(canvasBox?.x).toBeGreaterThanOrEqual(
      (navBox?.x ?? 0) + (navBox?.width ?? 0),
    );
  } else {
    expect((canvasBox?.y ?? 0) + (canvasBox?.height ?? 0)).toBeLessThanOrEqual(
      navBox?.y ?? 0,
    );
  }
}
