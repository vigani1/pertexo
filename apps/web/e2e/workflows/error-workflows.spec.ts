import { installWorkflowSettingsReads } from '../../test/support/browser/mock-reads';
import { test, expect } from '../support/fixtures';
import {
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
  editorUrl,
} from '../workflow-editor/support';

const target = '99999999-9999-4999-8999-999999999999';

for (const width of [1280, 375])
  test(`error workflow settings preserve an uncertain change on ${String(width)}px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.context().addCookies([
      {
        name: 'pertexo_csrf',
        value: 'csrf-error-workflow-browser-123456789012345678901234',
        url: baseURL ?? 'http://127.0.0.1:4173',
      },
    ]);
    await installEditorRoutes(page, remoteDraft());
    await installWorkflowSettingsReads(page);
    let settings: {
      targetWorkflowId: string | null;
      targetWorkflowName?: string | null;
      revision: number;
    } = { targetWorkflowId: null, revision: 1 };
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/error-workflow/targets`,
      (route) =>
        route.fulfill({
          json: {
            items: [{ id: target, name: 'Handle failed invoices' }],
            nextCursor: null,
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/error-workflow`,
      async (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({ json: settings });
        writes.push({
          body: route.request().postDataJSON(),
          key: route.request().headers()['idempotency-key'],
        });
        settings = {
          targetWorkflowId: target,
          targetWorkflowName: 'Handle failed invoices',
          revision: 2,
        };
        if (writes.length === 1) return route.abort('failed');
        return route.fulfill({ json: { settings, replayed: true } });
      },
    );
    await page.goto(`${editorUrl}/settings`);
    const section = page.getByRole('region', {
      name: 'Error workflow',
      exact: true,
    });
    await section.getByRole('button', { name: 'Change' }).click();
    const picker = section.getByRole('combobox', {
      name: 'When this workflow fails, run …',
    });
    await picker.focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('option', { name: 'Handle failed invoices', exact: true })
      .click();
    await section
      .getByRole('button', { name: 'Save error workflow', exact: true })
      .click();
    await expect(
      section.getByText(/The change could not be confirmed/u),
    ).toBeVisible();
    await expect(picker).toBeDisabled();
    await section
      .getByRole('button', { name: 'Retry same change', exact: true })
      .click();
    await expect(
      page.getByText('Error workflow saved', { exact: true }),
    ).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    expect(writes[0]?.body).toEqual({
      targetWorkflowId: target,
      expectedRevision: 1,
    });
    await page.reload();
    await expect(
      section.getByText(
        'When this workflow fails, Pertexo runs Handle failed invoices.',
      ),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await section.screenshot({
      path: testInfo.outputPath(`error-workflow-${String(width)}.png`),
    });
  });
test('a viewer reads the selected policy without receiving edit target discovery', async ({
  page,
}) => {
  await installEditorRoutes(page, remoteDraft(), {
    accessibleWorkspace: {
      ...workspace,
      role: 'viewer',
      capabilities: ['workspace:read', 'workflow:read'],
    },
  });
  await installWorkflowSettingsReads(page);
  let discovery = 0;
  await page.route('**/error-workflow/targets', (route) => {
    discovery++;
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route('**/error-workflow', (route) =>
    route.fulfill({ json: { targetWorkflowId: target, revision: 2 } }),
  );
  await page.goto(`${editorUrl}/settings`);
  const section = page.getByRole('region', {
    name: 'Error workflow',
    exact: true,
  });
  await expect(
    section.getByText(/Changing it takes edit access to both workflows/u),
  ).toBeVisible();
  await expect(section.getByRole('combobox')).toHaveCount(0);
  expect(discovery).toBe(0);
});
