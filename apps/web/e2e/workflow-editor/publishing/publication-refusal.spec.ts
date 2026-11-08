import { expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';
for (const width of [375, 1280])
  test(`keeps every publish refusal in Issues at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    const remote = remoteDraft({
      nodes: [
        {
          id: 'target',
          label: 'Target',
          definition: { key: 'core.manual', version: 1 },
          configVersion: 1,
          position: { x: 0, y: 0 },
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
      edges: [],
      settings: {},
    });
    await installEditorRoutes(page, remote);
    const messages = [
      'Workspace variable RATE does not exist. Add it in Settings → Variables.',
      'Choose a current task audience.',
    ] as const;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
      (route) =>
        route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:workflow.invalid',
            title: 'Invalid workflow',
            status: 422,
            code: 'workflow.invalid',
            requestId: 'refusal',
            errors: [
              {
                path: 'nodes.target.inputMappings.rate',
                code: 'invalid_mapping',
                message: messages[0],
              },
              {
                path: 'nodes.target.config.audience',
                code: 'invalid_audience',
                message: messages[1],
              },
            ],
          },
        }),
    );
    await page.goto(editorUrl);
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Publish v1',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Publish v1', exact: true })
      .click();
    await expect(
      dialog.getByRole('button', { name: `Fix: ${messages[1]}` }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: `Fix: ${messages[0]}` }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'Variables', exact: true }),
    ).toHaveAttribute('href', `/w/${workspaceId}/settings/variables`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /2 issues/u }).click();
    const issues = page.getByRole('region', { name: '2 issues', exact: true });
    await expect(issues.getByText(messages[1], { exact: true })).toBeVisible();
    await expect(
      page.getByText('Nothing blocks publishing.', { exact: true }),
    ).toHaveCount(0);
    await issues.getByRole('button', { name: `Fix: ${messages[0]}` }).click();
    await expect(
      page.getByRole('button', { name: 'Close step panel' }),
    ).toBeVisible();
    expect(remote.revision).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
