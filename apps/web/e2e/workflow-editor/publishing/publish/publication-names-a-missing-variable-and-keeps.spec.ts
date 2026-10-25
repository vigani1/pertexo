import { expect, test } from '../../../support/fixtures';

import { addStep } from '../../actions';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workflowSummary,
  workspaceId,
  type Graph,
} from '../../support';

import { installPublishRoutes, routeVersions, versionId } from './fixture';

for (const width of [1280, 375])
  test(`publication names a missing variable and keeps the draft for retry at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const remote = remoteDraft();
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote);
    await installPublishRoutes(page, remote);
    const keys: (string | undefined)[] = [];
    const name = width === 375 ? 'A'.repeat(64) : 'RATE';
    const message = `Workspace variable ${name} does not exist. Add it in Settings → Variables.`;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/publish`,
      (route) => {
        keys.push(route.request().headers()['idempotency-key']);
        if (keys.length > 1) return route.fallback();
        return route.fulfill({
          status: 422,
          contentType: 'application/problem+json',
          json: {
            type: 'urn:pertexo:problem:workflow.invalid',
            title: 'Invalid workflow',
            status: 422,
            code: 'workflow.invalid',
            requestId: 'variable-publish',
            errors: [
              {
                path: 'nodes.target.inputMappings.rate',
                code: 'invalid_mapping',
                message,
              },
            ],
          },
        });
      },
    );
    await page.goto(editorUrl);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Add step', exact: true })
        .click();
    await addStep(page, /Set fields/u).click();
    await expect.poll(() => remote.revision).toBe(2);
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Canvas', exact: true })
        .click();
    const savedGraph = structuredClone(remote.graph);
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Publish v1',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Publish v1', exact: true })
      .click();
    await expect(dialog.getByText(message, { exact: true })).toBeVisible();
    expect(remote.graph).toEqual(savedGraph);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `/tmp/pertexo-variable-publish-${String(width)}.png`,
    });
    await dialog
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
    expect(remote.graph).toEqual(savedGraph);
  });

for (const width of [375, 990, 1440]) {
  test(`directs an unconfigured published webhook to Triggers at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const graph: Graph = {
      settings: {},
      edges: [],
      nodes: [
        {
          id: 'incoming',
          definition: { key: 'core.webhook', version: 1 },
          position: { x: 0, y: 0 },
          configVersion: 1,
          config: {},
          inputMappings: {},
          connectionRefs: {},
        },
      ],
    };
    await installEditorRoutes(page, remoteDraft(graph));
    const summary = workflowSummary('Incoming orders', versionId);
    summary.workflow.activationStatus = 'activating';
    summary.workflow.webhookSetupRequired = true;
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}`,
      (route) => route.fulfill({ json: summary }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}?include=templateOrigin`,
      (route) => route.fulfill({ json: { ...summary, templateOrigin: null } }),
    );
    await routeVersions(page, () => graph, 'a');
    await page.route(
      `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/triggers`,
      () => {
        throw new Error('Summary state must not fetch trigger credentials');
      },
    );
    await page.goto(editorUrl);
    const setup = page.getByRole('link', {
      name: 'Trigger needs setup — open Triggers',
      exact: true,
    });
    await expect(setup).toBeVisible();
    await expect(setup).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/triggers`,
    );
    await expect(page.getByText('Starting', { exact: true })).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath(`trigger-setup-${String(width)}.png`),
      fullPage: true,
    });
  });
}
