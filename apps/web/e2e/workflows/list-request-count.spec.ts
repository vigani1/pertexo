import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workflowSummary,
  workspaceId,
} from '../workflow-editor/support';
import {
  workflowListBody,
  routeEmptyWorkflowOrganization,
} from './list-support';

test('renders 50 workflow summaries without row requests', async ({
  page,
  context,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 768 });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remoteDraft());
  await routeEmptyWorkflowOrganization(page, workspaceId);
  const items = Array.from({ length: 50 }, (_, index) => ({
    ...workflowSummary(`Workflow ${String(index)}`).workflow,
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`,
    listSummary: { shape: { nodes: [], edges: [] }, recentRuns: [] },
  }));
  let listReads = 0;
  const rowReads: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    const path = url.pathname;
    if (
      /\/workflows\/[^/]+\/(draft|runs)$/u.test(path) ||
      (path.endsWith('/runs') && url.searchParams.has('workflowId'))
    )
      rowReads.push(path);
  });
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) => {
    listReads += 1;
    return route.fulfill({
      json: workflowListBody(route.request().url(), items),
    });
  });
  await page.goto(`/w/${workspaceId}/workflows`);
  const showAll = page.getByRole('button', {
    name: 'Show all 50',
    exact: true,
  });
  const rows = page.getByRole('list', { name: 'Workflows', exact: true });
  await expect(rows.getByRole('listitem')).toHaveCount(5);
  await expect(showAll).toHaveAttribute('aria-expanded', 'false');
  await showAll.click();
  await expect(
    page.getByRole('button', { name: 'Show fewer', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('link', { name: 'Workflow 49', exact: true }),
  ).toBeAttached();
  for (let index = 0; index < 50; index += 1) {
    await page
      .getByRole('link', { name: `Workflow ${String(index)}`, exact: true })
      .scrollIntoViewIfNeeded();
  }
  console.info(
    JSON.stringify({ workflows: 50, listReads, rowReads: rowReads.length }),
  );
  expect(rowReads).toEqual([]);
  expect(listReads).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('workflow-list.png') });
});
