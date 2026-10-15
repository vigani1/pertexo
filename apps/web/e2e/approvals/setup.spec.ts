import { expect, test, type Page } from '../support/fixtures';
import { approvalConfigSchema } from '@pertexo/workflow-model';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from '../workflow-editor/support';
const definition = platformBrowserNodeDefinitionCatalog().definitions.find(
  (item) => item.definition.key === 'core.approval',
);
if (definition === undefined) throw new Error('Approval definition missing');
const label = 'Allow the person who started the run to decide';
const warning =
  'If you start this run, nobody else in this audience can decide. Allow the starter or choose another member.';
async function open(page: Page, width: number) {
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-review').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}
for (const width of [1280, 375])
  test(`approval starter choice and whole-audience hint at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const remote = remoteDraft({
      nodes: [
        {
          id: 'review',
          definition: { key: 'core.approval', version: 1 },
          configVersion: 1,
          config: approvalConfigSchema.parse({
            audience: { roles: ['owner'], memberIds: [] },
          }),
          inputMappings: {},
          connectionRefs: {},
          position: { x: 80, y: 80 },
        },
      ],
      edges: [],
      settings: {},
    });
    await installEditorRoutes(page, remote, { definitions: [definition] });
    await addCsrfCookie(context);
    await open(page, width);
    const checkbox = page.getByRole('checkbox', { name: label, exact: true });
    await expect(checkbox).not.toBeChecked();
    await expect(page.getByText(warning, { exact: true })).toBeVisible();
    await checkbox.focus();
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
    await expect
      .poll(() => remote.graph.nodes)
      .toMatchObject([{ config: { allowStarterToDecide: true } }]);
    await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByTestId('rf__node-review').click();
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect
      .poll(() => remote.graph.nodes)
      .toMatchObject([{ config: { allowStarterToDecide: false } }]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test('does not mistake one visible roster page for the entire audience; readers cannot edit', async ({
  page,
  context,
}) => {
  const remote = remoteDraft({
    nodes: [
      {
        id: 'review',
        definition: { key: 'core.approval', version: 1 },
        configVersion: 1,
        config: approvalConfigSchema.parse({}),
        inputMappings: {},
        connectionRefs: {},
        position: { x: 80, y: 80 },
      },
    ],
    edges: [],
    settings: {},
  });
  await installEditorRoutes(page, remote, { definitions: [definition] });
  await page.route(
    `**/v1/workspaces/${workspaceId}/pending-tasks/audience/inspect`,
    (route) =>
      route.fulfill({
        json: { matchingMemberCount: 62, actorMatchesAudience: true },
      }),
  );
  await addCsrfCookie(context);
  await open(page, 1280);
  await expect(
    page.getByRole('checkbox', { name: label, exact: true }),
  ).toBeEnabled();
  await expect(page.getByText(warning, { exact: true })).toHaveCount(0);
  await installEditorRoutes(page, remote, {
    definitions: [definition],
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read', 'run:read'],
    },
  });
  let inspected = false;
  await page.route(
    `**/v1/workspaces/${workspaceId}/pending-tasks/audience/inspect`,
    (route) => {
      inspected = true;
      return route.abort();
    },
  );
  await open(page, 1280);
  await expect(
    page.getByRole('checkbox', { name: label, exact: true }),
  ).toBeDisabled();
  expect(inspected).toBe(false);
});
