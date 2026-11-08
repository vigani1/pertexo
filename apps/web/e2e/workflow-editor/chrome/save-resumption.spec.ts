import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
} from '../support';
for (const width of [375, 1280])
  test(`autosaves retained edits after original-account verification at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    const remote = remoteDraft({ nodes: [], edges: [], settings: {} });
    await installEditorRoutes(page, remote);
    let original = true;
    await page.route('**/v1/users/me', (route) =>
      route.fulfill({
        json: original
          ? user
          : {
              ...user,
              id: '99999999-9999-4999-8999-999999999999',
              email: 'other@example.test',
            },
      }),
    );
    await page.goto(editorUrl);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await page
      .getByRole('complementary', { name: 'Add a step' })
      .getByRole('button', { name: /Set fields/u })
      .click();
    original = false;
    await expect(
      page.getByRole('heading', { name: 'Editor paused' }),
    ).toBeVisible();
    expect(remote.revision).toBe(1);
    original = true;
    await page.getByRole('button', { name: 'Verify original account' }).click();
    await expect(
      page.getByRole('heading', { name: 'Editor paused' }),
    ).toHaveCount(0);
    await expect.poll(() => remote.revision).toBe(2);
    expect(remote.graph.nodes).toHaveLength(1);
  });
