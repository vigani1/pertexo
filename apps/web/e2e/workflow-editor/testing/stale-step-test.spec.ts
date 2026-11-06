import { expect, test } from '../../support/fixtures';
import { editorNode } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';

for (const width of [1280, 375]) {
  test(`explains late step-test draft conflicts at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({
        nodes: [editorNode('sample', 'Sample source', 'real', 80)],
        edges: [],
        settings: {},
      }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/nodes/sample/test`,
      (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:workflow.revision_conflict',
            title: 'Workflow draft changed',
            status: 409,
            code: 'workflow.revision_conflict',
            detail:
              'The saved draft changed. Refresh the draft and prepare the step test again.',
            requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        }),
    );
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-sample').focus();
    await page.keyboard.press('Enter');
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page
      .getByRole('switch', { name: 'I understand this test runs for real' })
      .click();
    await page.getByRole('button', { name: 'Run test', exact: true }).click();
    await expect(
      page.getByText(
        'The saved draft changed. Refresh the draft and prepare the step test again.',
      ),
    ).toBeVisible();
    await page
      .getByText(
        'The saved draft changed. Refresh the draft and prepare the step test again.',
      )
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath('stale-step-test.png'),
      fullPage: true,
    });
  });
}
