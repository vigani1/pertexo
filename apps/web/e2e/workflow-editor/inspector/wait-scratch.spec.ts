import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { platformBrowserNodeDefinitionCatalog } from '@pertexo/node-catalog';
import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

for (const width of [375, 1280]) {
  test(`keeps an unfinished Wait editable before changing mode at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    const remote = remoteDraft({
      nodes: [
        {
          id: 'wait',
          label: 'Wait here',
          definition: { key: 'core.wait', version: 1 },
          configVersion: 1,
          position: { x: 80, y: 80 },
          config: { durationSeconds: 60 },
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    });
    await installEditorRoutes(page, remote, {
      definitions: platformBrowserNodeDefinitionCatalog().definitions.filter(
        ({ definition }) => definition.key === 'core.wait',
      ),
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-wait').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    const duration = page.getByRole('textbox', {
      name: 'Wait for',
      exact: true,
    });
    await duration.fill('unfinished');
    await duration.press('Tab');
    const mode = page.getByRole('combobox', { name: 'Wait until' });
    await expect(mode).toBeDisabled();
    await expect(duration).toHaveValue('unfinished');
    await expect(
      page.getByText(
        'Fix the unfinished edit before changing how this step waits.',
      ),
    ).toBeVisible();
    expect(parseWorkflowGraphDraft(remote.graph).nodes[0]?.config).toEqual({
      durationSeconds: 60,
    });
    await duration.fill('2');
    await expect(mode).toBeEnabled();
    await mode.click();
    await page
      .getByRole('option', { name: 'Called back', exact: true })
      .click();
    await expect(
      page.getByRole('textbox', { name: 'Give up after', exact: true }),
    ).toBeVisible();
    await expect
      .poll(() => parseWorkflowGraphDraft(remote.graph).nodes[0]?.config.mode)
      .toBe('callback');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page).toHaveURL(editorUrl);
  });
}
