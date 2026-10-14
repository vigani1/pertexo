import { expect } from '@playwright/test';
import { test } from '../support/browser-fixture';
import { createOwnedHttpConnection } from '../support/authoring/http-connection';
import { authorWebhookHttpGraph } from '../support/authoring/webhook-http';
import {
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

test('browser-authored failure link handles a definite error but never an unknown effect', async ({
  page,
  request,
}) => {
  const { controlOrigin, workspaceId } = await createOwnedHttpConnection(
    page,
    request,
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Failure handling proof',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow ID missing');
  const authored = await authorWebhookHttpGraph(
    page,
    workflowPath,
    readEditorDraft,
    true,
  );
  await page.getByTestId(`rf__node-${authored.httpId}`).focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Step panel' });
  await panel.getByRole('tab', { name: 'Setup', exact: true }).click();
  await panel
    .getByRole('button', { name: 'Follow failure link', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Follow a failure link' })
    .getByRole('button', { name: 'Add handler step…' })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a step after “Owned HTTP effect”' })
    .getByRole('button', { name: /Set fields/u })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.length,
    )
    .toBe(7);
  const handler = (await readEditorDraft(page, workflowPath)).graph.nodes.find(
    (node) => !authored.graph.nodes.some((previous) => previous.id === node.id),
  );
  if (handler === undefined || authored.stopId === undefined)
    throw new Error('Handler or normal stop missing');
  await page.getByLabel('Label', { exact: true }).fill('Record failure');
  await page.keyboard.press('Tab');
  await panel.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await panel.getByRole('button', { name: 'Insert data', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Insert data', exact: true })
    .getByRole('button', { name: /All safe failure fields/u })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.find(
          (node) => node.id === handler.id,
        )?.inputMappings,
    )
    .toEqual({
      failure: { kind: 'node_failure', nodeId: authored.httpId, path: '$' },
    });
  const saved = (await readEditorDraft(page, workflowPath)).graph;
  await page.reload();
  expect((await readEditorDraft(page, workflowPath)).graph).toEqual(saved);
  const version = await publishSingleStep(page, workflowPath);
  const input = (marker: string) => ({
    execute: true,
    body: { encoding: 'utf8', value: JSON.stringify({ marker }) },
  });
  const handledRunId = await startSingleStep(page, input('recovery-once'));
  const handled = await waitForRun(
    page,
    workspaceId,
    handledRunId,
    'succeeded',
  );
  expect(handled.run.handledFailureCount).toBe(1);
  expect(
    handled.nodes.find((node) => node.nodeId === authored.httpId),
  ).toMatchObject({
    status: 'failed',
    failureHandling: { disposition: 'handled' },
  });
  expect(handled.nodes.find((node) => node.nodeId === handler.id)?.status).toBe(
    'succeeded',
  );
  await expect(
    page.getByText('Finished — 1 failure handled', { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: /Owned HTTP effect: Failed · failure handled/u,
    })
    .click();
  await expect(
    page.getByText(
      'The selected handler finished successfully. This source step remains failed.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
  const unknownRunId = await startSingleStep(page, input('recovery-unknown'));
  const unknown = await waitForRun(
    page,
    workspaceId,
    unknownRunId,
    'outcome_unknown',
  );
  expect(unknown.run.handledFailureCount ?? 0).toBe(0);
  expect(unknown.nodes.find((node) => node.nodeId === handler.id)?.status).toBe(
    'skipped',
  );
  await expect(
    page.getByRole('button', { name: 'Retry from this step', exact: true }),
  ).toHaveCount(0);
  const evidence = await request.post(
    `${controlOrigin}/evidence/failure-routing`,
    {
      data: {
        workspaceId,
        workflowId,
        workflowVersionId: version.id,
        handledRunId,
        unknownRunId,
        sourceId: authored.httpId,
        handlerId: handler.id,
        normalStopId: authored.stopId,
      },
    },
  );
  expect(evidence.status()).toBe(204);
});
