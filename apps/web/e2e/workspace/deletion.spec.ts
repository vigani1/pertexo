import { expect, test } from '../support/fixtures';
import {
  createUserFixture,
  createWorkspaceFixture,
} from '../../test/support/fixtures/identity';

for (const width of [375, 1280]) {
  test(`shows current-member deletion and session completion at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    const workspace = createWorkspaceFixture({
      status: 'purging',
      capabilities: [],
    });
    let gone = false;
    await page.route('**/v1/users/me', (route) =>
      route.fulfill({ json: createUserFixture() }),
    );
    await page.route('**/v1/workspaces?**', (route) =>
      route.fulfill({
        json: { items: gone ? [] : [workspace], nextCursor: null },
      }),
    );
    await page.goto(`/w/${workspace.id}`);
    await expect(
      page.getByRole('heading', { name: 'This workspace is being deleted' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    gone = true;
    await page.getByRole('button', { name: 'Refresh deletion status' }).click();
    await expect(
      page.getByText(
        'Deletion finished. This workspace and its data are gone.',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Choose a workspace' }),
    ).toHaveAttribute('href', '/workspaces');
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'This workspace isn’t available' }),
    ).toBeVisible();
    await expect(page.getByText(/Deletion finished/u)).toHaveCount(0);
  });
}
