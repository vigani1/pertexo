import { expect, type APIRequestContext, type Browser } from '@playwright/test';
import { apiProblemSchema } from '@pertexo/contracts/schemas/errors';
import { accessibleWorkspacesResponseSchema } from '@pertexo/contracts/schemas/identity-workspace';
import { workflowListResponseSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './ordinary-editor-session';

/** Existing authoring/run guards use nondisclosing 404, not a shared status rule. */
export async function verifyEditorWorkspaceIsolation(
  browser: Browser,
  request: APIRequestContext,
  input: Readonly<{
    origin: string;
    mailOrigin: string;
    workspaceId: string;
    workflowId: string;
    runId: string;
  }>,
) {
  const context = await browser.newContext({ baseURL: input.origin });
  try {
    const page = await context.newPage();
    await registerEditorUser(
      page,
      request,
      input.mailOrigin,
      'Independent workspace owner',
    );
    const ownWorkspaceId = await createEditorWorkspace(
      page,
      'Isolated editor workspace',
    );
    expect(ownWorkspaceId).not.toBe(input.workspaceId);
    const discoveryResponse = await page.request.get('/v1/workspaces');
    expect(discoveryResponse.status()).toBe(200);
    expect(
      accessibleWorkspacesResponseSchema
        .parse(await discoveryResponse.json())
        .items.map((workspace) => workspace.id),
    ).toEqual([ownWorkspaceId]);
    const ownList = await page.request.get(
      `/v1/workspaces/${ownWorkspaceId}/workflows`,
    );
    expect(ownList.status()).toBe(200);
    expect(
      workflowListResponseSchema.parse(await ownList.json()).items,
    ).toEqual([]);
    const workflowPath = `/v1/workspaces/${input.workspaceId}/workflows/${input.workflowId}`;
    for (const path of [
      `${workflowPath}/draft`,
      `${workflowPath}/versions`,
      `/v1/workspaces/${input.workspaceId}/runs`,
      `/v1/workspaces/${input.workspaceId}/runs/${input.runId}`,
    ]) {
      const response = await page.request.get(path);
      expect(response.status()).toBe(404);
      const body: unknown = await response.json();
      // Validate the generic problem and separately check permitted text fields.
      // The requested IDs may appear in instance; protected content must not.
      for (const protectedText of [
        'Pure core browser execution',
        'Mapping source',
        'Local source choice',
        'Remote source choice',
        'from-real-browser',
        'unpublished-after-run',
      ])
        expect(JSON.stringify(body)).not.toContain(protectedText);
      expect(apiProblemSchema.parse(body)).toMatchObject({
        status: 404,
        code: 'resource.not_found',
        title: 'Resource not found',
      });
    }
    await page.goto(`/w/${input.workspaceId}/workflows/${input.workflowId}`);
    await expect(
      page.getByRole('heading', {
        name: 'This workspace isn’t available',
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Add a step' }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Pure core browser execution', { exact: true }),
    ).toHaveCount(0);
    return ownWorkspaceId;
  } finally {
    await context.close();
  }
}
