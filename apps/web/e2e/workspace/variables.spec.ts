import { expect, test } from '../support/fixtures';
import { mappingGraph } from '../workflow-editor/graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
} from '../workflow-editor/support';
for (const width of [1280, 375])
  test(`typed variables retain an uncertain command and a conflicting draft at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installEditorRoutes(page, remoteDraft(), {
      accessibleWorkspace: {
        ...workspace,
        capabilities: [...workspace.capabilities, 'variable:manage'],
      },
    });
    await addCsrfCookie(context);
    let revision = 1;
    let value = 10;
    let description = 'Rate applied to invoices.';
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/variables`,
      async (route) => {
        const request = route.request();
        if (request.method() === 'GET')
          return route.fulfill({
            json: {
              revision,
              values: { RATE: value },
              descriptions: { RATE: description },
            },
          });
        expect(request.headers()['x-csrf-token']).toBeTruthy();
        writes.push({
          body: request.postDataJSON() as unknown,
          key: request.headers()['idempotency-key'],
        });
        if (writes.length === 1)
          return route.fulfill({
            status: 502,
            contentType: 'application/problem+json',
            json: {
              type: 'about:blank',
              title: 'Gateway failed',
              status: 502,
              code: 'internal.unexpected',
              requestId: 'test',
            },
          });
        if (writes.length === 2) {
          revision = 2;
          value = 20;
          description = 'Rate for new invoices.';
          return route.fulfill({
            json: { revision, changed: true, replayed: true },
          });
        }
        revision = 3;
        value = 30;
        description = 'New server description.';
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: {
            type: 'about:blank',
            title: 'Conflict',
            status: 409,
            code: 'variables.changed',
            requestId: 'test',
          },
        });
      },
    );
    await page.goto(`/w/${workspaceId}/settings/variables`);
    const row = page.getByRole('region', { name: 'RATE', exact: true });
    const edit = row.getByRole('button', { name: 'Edit RATE', exact: true });
    await edit.click();
    await expect(
      row.getByLabel('Description (optional)', { exact: true }),
    ).toHaveValue('Rate applied to invoices.');
    await row.getByLabel('Value', { exact: true }).fill('20');
    await row
      .getByLabel('Description (optional)', { exact: true })
      .fill('Rate for new invoices.');
    await page
      .getByRole('button', { name: 'Save variables', exact: true })
      .click();
    await expect(row.getByLabel('Value', { exact: true })).toBeDisabled();
    await page
      .getByRole('button', { name: 'Retry same save', exact: true })
      .click();
    await expect(
      page.getByText('Saved revision 2 for new runs', { exact: true }),
    ).toBeVisible();
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toEqual({
      expectedRevision: 1,
      values: { RATE: 20 },
      descriptions: { RATE: 'Rate for new invoices.' },
    });
    // A saved row closes back to its summary.
    await expect(row.getByLabel('Value', { exact: true })).toHaveCount(0);
    await edit.click();
    await row.getByLabel('Value', { exact: true }).fill('40');
    await page
      .getByRole('button', { name: 'Save variables', exact: true })
      .click();
    await expect(
      page.getByText(/Someone changed the shared values/u),
    ).toBeVisible();
    await expect(row.getByLabel('Value', { exact: true })).toHaveValue('40');
    await expect(
      row.getByLabel('Description (optional)', { exact: true }),
    ).toHaveValue('Rate for new invoices.');
    expect(writes[2]?.key).not.toBe(writes[0]?.key);
    await page
      .getByRole('button', {
        name: 'Discard changes',
        exact: true,
      })
      .click();
    await expect(row.getByLabel('Value', { exact: true })).toHaveValue('30');
    await expect(
      row.getByLabel('Description (optional)', { exact: true }),
    ).toHaveValue('New server description.');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test('members can inspect references and an empty scan page is never presented as unused', async ({
  page,
}) => {
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read', 'run:read'],
    },
  });
  await page.route(`**/v1/workspaces/${workspaceId}/variables`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        values: { RATE: 0 },
        descriptions: { RATE: 'Rate applied to invoices.' },
      },
    }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/variables/usage?**`,
    (route) =>
      route.fulfill({
        json: route.request().url().includes('after=')
          ? {
              items: [
                {
                  id: 'a'.repeat(64),
                  workflowId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
                  workflowName: 'Invoice export',
                  archived: true,
                  stage: 'published',
                  nodeId: 'set',
                  label: 'Set currency',
                  input: 'currency',
                  kind: 'dynamic',
                },
              ],
              nextCursor: null,
              incomplete: false,
            }
          : { items: [], nextCursor: 'cursor', incomplete: false },
      }),
  );
  await page.goto(`/w/${workspaceId}/settings/variables`);
  await expect(
    page.getByRole('button', { name: 'Save variables', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Rate applied to invoices.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'References', exact: true }).click();
  await expect(
    page.getByText(
      'No matches in the workflows checked so far. Continue the check.',
      { exact: true },
    ),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Check more workflows', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Invoice export', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Computed lookup or whole-map expression; may use any variable.',
      { exact: true },
    ),
  ).toBeVisible();
});

test('the mapping picker inserts a typed scalar reference without an expression', async ({
  page,
  context,
}) => {
  const draft = remoteDraft(mappingGraph());
  await installEditorRoutes(page, draft);
  await addCsrfCookie(context);
  await page.route(`**/v1/workspaces/${workspaceId}/variables`, (route) =>
    route.fulfill({
      json: {
        revision: 1,
        values: { RATE: 0 },
        descriptions: { RATE: 'Rate applied to invoices.' },
      },
    }),
  );
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-target').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Insert data', exact: true }).click();
  await expect(
    page.getByText('Rate applied to invoices.', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /\$vars\.RATE/u }).click();
  await expect
    .poll(() => draft.graph.nodes)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'target',
          inputMappings: { rate: { kind: 'workspace_variable', name: 'RATE' } },
        }),
      ]),
    );
});
