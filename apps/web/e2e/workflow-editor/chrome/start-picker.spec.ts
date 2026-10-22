import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  manualDefinition,
  remoteDraft,
} from '../support';

// Its description is the longest, so its one line sets the card's width.
const failureTrigger = {
  ...manualDefinition,
  definition: { key: 'core.workflow_error', version: 1 },
};

for (const width of [375, 390]) {
  test(`an empty draft's trigger choices fit a ${String(width)} px phone`, async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width, height: 812 });
    await addCsrfCookie(context);
    await installEditorRoutes(page, remoteDraft(), {
      definitions: [manualDefinition, failureTrigger, definition],
    });
    await page.goto(editorUrl);

    const starter = page.getByRole('region', { name: 'Start with a trigger' });
    await expect(starter).toBeVisible();
    const card = await starter.boundingBox();
    if (card === null) throw new Error('The starter is not on screen');
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(width);
    const choice = await starter
      .getByRole('button', { name: /When a workflow fails/u })
      .boundingBox();
    if (choice === null) throw new Error('The failure choice is not on screen');
    expect(choice.x + choice.width).toBeLessThanOrEqual(width);
  });
}
