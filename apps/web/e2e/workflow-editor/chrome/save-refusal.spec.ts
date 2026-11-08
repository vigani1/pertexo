import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workflowId,
} from '../support';

for (const width of [375, 1280]) {
  test(`explains a refused save visibly beside recovery at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    const remote = remoteDraft({ nodes: [], edges: [], settings: {} });
    await installEditorRoutes(page, remote);
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`,
      async (route) => {
        if (route.request().method() !== 'PUT') return route.fallback();
        await route.fulfill({
          status: 403,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:auth.forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'auth.forbidden',
            requestId: 'save-refused',
          },
        });
      },
    );
    await page.goto(editorUrl);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await page
      .getByRole('complementary', { name: 'Add a step' })
      .getByRole('button', { name: /Set fields/ })
      .click();
    const reason = page.getByText(
      'Your role no longer allows editing this workflow.',
      { exact: true },
    );
    await expect(reason).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry', exact: true }),
    ).toHaveAccessibleDescription(
      'Your role no longer allows editing this workflow.',
    );
    expect(remote.revision).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/h2-save-refused-${String(width)}.png`,
    });
  });
}
