import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
  workflowSummary,
} from '../workflow-editor/support';

for (const width of [375, 1280]) {
  test(`recovers the original file import after choosing an example at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({ nodes: [], edges: [], settings: {} }),
      {
        accessibleWorkspace: {
          ...workspace,
          capabilities: [...workspace.capabilities, 'workflow:create'],
        },
      },
    );
    const attempts: { body: unknown; key: string | undefined }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/import/preview`,
      (route) =>
        route.fulfill({
          json: {
            manifestDigest: 'b'.repeat(64),
            compatibilityFingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
            compatible: true,
            issues: [],
            truncated: false,
            connectionSlots: [],
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/import`,
      async (route) => {
        attempts.push({
          body: route.request().postDataJSON() as unknown,
          key: route.request().headers()['idempotency-key'],
        });
        await route.abort('failed');
      },
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    await page.getByRole('button', { name: 'Import workflow…' }).click();
    const manifest = {
      format: 'pertexo.workflow',
      graph: { nodes: [], edges: [], settings: {} },
      requirements: { definitions: [] },
      connectionSlots: [],
    };
    await page.getByLabel('Workflow JSON file').setInputFiles({
      name: 'portable.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(manifest)),
    });
    await page.getByLabel('New workflow name').fill('Original file import');
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page
      .getByRole('button', { name: 'Import unpublished draft' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Retry exact import' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    const example = CURATED_WORKFLOW_TEMPLATES[0];
    if (example === undefined) throw new Error('Expected an example');
    await page
      .getByRole('button', { name: new RegExp(example.title, 'u') })
      .click();
    await expect(page.getByLabel('New workflow name')).toHaveValue(
      'Original file import',
    );
    await page.getByRole('button', { name: 'Retry exact import' }).click();
    await expect.poll(() => attempts.length).toBe(2);
    expect(attempts[1]).toEqual(attempts[0]);
    await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

  test(`keeps publication discovery failure recoverable at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await installEditorRoutes(
      page,
      remoteDraft({ nodes: [], edges: [], settings: {} }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
      (route) =>
        route.fulfill({
          json: workflowSummary(
            'Form workflow',
            'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          ),
        }),
    );
    for (const endpoint of ['triggers', 'triggers/schedules'])
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/${endpoint}`,
        (route) => route.fulfill({ json: { items: [] } }),
      );
    let reads = 0;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
      async (route) => {
        reads += 1;
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:internal.unexpected',
            code: 'internal.unexpected',
            title: 'Unavailable',
            status: 503,
            requestId: 'publication-discovery',
          },
        });
      },
    );
    await page.goto(`/w/${workspaceId}/workflows/${workflowId}/triggers`);
    const retry = page.getByRole('button', { name: 'Retry', exact: true });
    await expect(retry).toBeVisible();
    await expect(
      page.getByText('This version has no trigger', { exact: true }),
    ).toHaveCount(0);
    const previousReads = reads;
    await retry.click();
    await expect.poll(() => reads).toBeGreaterThan(previousReads);
    await expect(
      page.getByRole('heading', { name: 'Schedules', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/h2-trigger-discovery-${String(width)}.png`,
    });
  });
}
