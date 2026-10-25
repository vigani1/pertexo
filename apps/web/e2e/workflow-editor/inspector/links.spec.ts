import { expect, test } from '../../support/fixtures';
import { mappingGraph } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../support';

for (const width of [390, 1280]) {
  test(`adds, removes and restores a link through keyboard controls at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = remoteDraft({ ...mappingGraph(), edges: [] });
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    const links = page.getByRole('region', {
      name: 'Linked from',
      exact: true,
    });
    await expect(
      links.getByText('Nothing leads into this step yet.'),
    ).toBeVisible();
    await links
      .getByRole('button', { name: 'Link a step', exact: true })
      .press('Enter');
    for (const [label, choice] of [
      ['Link from step', 'Manual input'],
      ['From output', 'out'],
      ['Into input', 'in'],
    ] as const) {
      await links.getByLabel(label, { exact: true }).press('Enter');
      await page
        .getByRole('option', { name: choice, exact: true })
        .press('Enter');
    }
    await links
      .getByRole('button', { name: 'Link', exact: true })
      .press('Enter');
    await expect.poll(() => remote.graph.edges.length).toBe(1);
    const remove = links.getByRole('button', {
      name: 'Remove link from Manual input',
      exact: true,
    });
    await expect(remove).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Remove connection from Manual input',
        exact: true,
      }),
    ).toHaveCount(0);
    await remove.press('Enter');
    await expect(page.getByText('Link removed', { exact: true })).toBeVisible();
    await expect.poll(() => remote.graph.edges.length).toBe(0);
    await page
      .getByRole('button', { name: 'Undo', exact: true })
      .last()
      .press('Enter');
    await expect(remove).toBeVisible();
    await expect.poll(() => remote.graph.edges.length).toBe(1);
    await page.reload();
    await page.getByTestId('rf__node-target').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await expect(remove).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
