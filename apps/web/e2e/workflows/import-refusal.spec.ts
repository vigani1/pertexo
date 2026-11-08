import { expect, test } from '../support/fixtures';
import {
  addCsrfCookie,
  installEditorRoutes,
  remoteDraft,
  workspace,
  workspaceId,
  workflowId,
} from '../workflow-editor/support';
for (const width of [375, 1280])
  test(`re-previews a refused import while retaining its name at ${String(width)}px`, async ({
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
    let previews = 0;
    const attempts: { key: string | undefined; body: unknown }[] = [];
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/import/preview`,
      (route) => {
        previews++;
        return route.fulfill({
          json: {
            manifestDigest: 'b'.repeat(64),
            compatibilityFingerprint: `wf-compat:sha256:${(previews === 1 ? 'a' : 'c').repeat(64)}`,
            compatible: true,
            issues: [],
            truncated: false,
            connectionSlots: [],
          },
        });
      },
    );
    const detail =
      'The destination catalog changed. Preview this import again before creating its draft.';
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/import`,
      (route) => {
        attempts.push({
          key: route.request().headers()['idempotency-key'],
          body: route.request().postDataJSON() as unknown,
        });
        return attempts.length === 1
          ? route.fulfill({
              status: 409,
              contentType: 'application/problem+json',
              json: {
                type: 'urn:pertexo:problem:workflow.portability_compatibility_conflict',
                title: 'Import changed',
                status: 409,
                code: 'workflow.portability_compatibility_conflict',
                detail,
                requestId: 'changed',
              },
            })
          : route.fulfill({ status: 201, json: { workflowId } });
      },
    );
    await page.goto(`/w/${workspaceId}/workflows`);
    await page.getByRole('button', { name: 'Import workflow…' }).click();
    await page.getByLabel('Workflow JSON file').setInputFiles({
      name: 'portable.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'pertexo.workflow',
          graph: { nodes: [], edges: [], settings: {} },
          requirements: { definitions: [] },
          connectionSlots: [],
        }),
      ),
    });
    await page.getByLabel('New workflow name').fill('Reviewed import');
    await page.getByRole('button', { name: 'Preview import' }).click();
    await page
      .getByRole('button', { name: 'Import unpublished draft' })
      .click();
    await expect(page.getByText(detail, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Import unpublished draft' }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Preview again' }).click();
    await expect(page.getByLabel('New workflow name')).toHaveValue(
      'Reviewed import',
    );
    await page
      .getByRole('button', { name: 'Import unpublished draft' })
      .click();
    await expect(
      page.getByRole('button', { name: 'Open imported workflow' }),
    ).toBeVisible();
    expect(attempts[0]?.key).toBeTruthy();
    expect(attempts[1]?.key).not.toBe(attempts[0]?.key);
    expect(attempts[1]?.body).toMatchObject({
      name: 'Reviewed import',
      expectedCompatibilityFingerprint: `wf-compat:sha256:${'c'.repeat(64)}`,
    });
    expect(previews).toBe(2);
  });
