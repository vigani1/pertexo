import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 375, height: 768 },
]) {
  test(`authors and removes a failure path with safe inputs and undo at ${String(viewport.width)}px`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize(viewport);
    if (viewport.width === 375)
      await page.emulateMedia({ reducedMotion: 'reduce' });
    const remote = remoteDraft(mappingGraph());
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote, {
      definitions: [manualDefinition, definition],
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-target').click();
    if (viewport.width === 375)
      await page.getByRole('button', { name: 'Step', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Step panel' });
    await expect(panel.getByText('On failure', { exact: true })).toBeVisible();
    const evidence = process.env.PERTEXO_VISUAL_EVIDENCE_DIR;
    if (evidence !== undefined) {
      await mkdir(evidence, { recursive: true });
      await page.screenshot({
        path: join(evidence, `failure-before-${String(viewport.width)}.png`),
      });
    }
    await panel
      .getByRole('button', { name: 'Follow failure link', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    const choice = page.getByRole('dialog', { name: 'Follow a failure link' });
    await expect(choice).toBeVisible();
    await choice.getByRole('button', { name: 'Add handler step…' }).click();
    const picker = page.getByRole('dialog', {
      name: 'Add a step after “Target”',
    });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: /Set fields/u }).click();
    await expect
      .poll(() =>
        remote.graph.edges.some(
          (edge) =>
            typeof edge === 'object' &&
            edge !== null &&
            'source' in edge &&
            (edge.source as { port: string }).port === '__failure',
        ),
      )
      .toBe(true);
    if (viewport.width === 375 && !(await panel.isVisible()))
      await page.getByRole('button', { name: 'Step', exact: true }).click();
    await panel.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await panel
      .getByRole('button', { name: 'Insert data', exact: true })
      .click();
    const data = page.getByRole('dialog', { name: 'Insert data', exact: true });
    await expect(
      data.getByText('Source failure', { exact: true }),
    ).toBeVisible();
    await data.getByRole('button', { name: /safeErrorCode/u }).click();
    await expect
      .poll(() => JSON.stringify(remote.graph))
      .toContain('node_failure');
    await page.reload();
    if (viewport.width === 375)
      await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await page.getByTestId('rf__node-target').click();
    if (viewport.width === 375)
      await page.getByRole('button', { name: 'Step', exact: true }).click();
    await expect(
      panel.getByRole('button', { name: 'Remove failure path', exact: true }),
    ).toBeVisible();
    if (evidence !== undefined)
      await page.screenshot({
        path: join(evidence, `failure-after-${String(viewport.width)}.png`),
      });
    await panel
      .getByRole('button', { name: 'Remove failure path', exact: true })
      .click();
    const remove = page.getByRole('dialog', {
      name: 'Remove this failure path?',
    });
    await expect(remove).toBeVisible();
    await expect(
      remove.getByText(/cannot become ordinary starting steps/u),
    ).toBeVisible();
    await remove
      .getByRole('button', { name: 'Remove failure path', exact: true })
      .click();
    await expect.poll(() => remote.graph.nodes.length).toBe(2);
    await page
      .getByRole('button', { name: 'Undo', exact: true })
      .first()
      .click();
    await expect.poll(() => remote.graph.nodes.length).toBe(3);
    expect(JSON.stringify(remote.graph)).toContain('node_failure');
  });
}
