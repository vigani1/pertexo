import { expect, test } from '../support/fixtures';
import {
  clearSpoken,
  expectSpoken,
  startScreenReader,
} from '../support/screen-reader';
import { firstRunId, installRoutes, workspaceId } from '../run-history/fixture';

test('a screen-reader user hears which page a link opened', async ({
  page,
}) => {
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  await installRoutes(page);
  await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await startScreenReader(page);
  await clearSpoken(page);

  // In a single-page app the browser doesn't load a page, so nothing is said
  // unless the app says it: the new page's name, as its title reads.
  await page
    .getByRole('navigation', { name: 'Breadcrumb' })
    .getByRole('link', { name: 'Runs', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/runs$`, 'u'));
  await expectSpoken(page, /^assertive: Runs · .+$/u);
});
