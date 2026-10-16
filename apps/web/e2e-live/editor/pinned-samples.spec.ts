import './draft-tests/journey.case';
import { expect, type Page } from '@playwright/test';
import {
  stepSampleResponseSchema,
  nodeTestExecuteAcceptedResponseSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';

async function selectStep(page: Page, nodeId: string) {
  await page.getByTestId(`rf__node-${nodeId}`).focus();
  await page.keyboard.press('Enter');
}
async function mapProof(page: Page) {
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('proof');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.proof');
  await page.keyboard.press('Tab');
}

test('draft pins skip execution, survive reload, go stale and never affect a published run', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Sample owner');
  const workspaceId = await createEditorWorkspace(page, 'Sample qualification');
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Pinned sample qualification',
  );
  const editorUrl = new URL(page.url()).pathname;
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /Set fields/u,
    'Sample source',
  );
  await mapProof(page);
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ proof: { kind: 'run_input', path: '$.proof' } });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByLabel('Sample input (JSON)', { exact: true })
    .fill('{"proof":"real-preview"}');
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(
    page.getByText('Setup looks right', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  await expect(page.getByRole('region', { name: 'Test result' })).toContainText(
    'real-preview',
  );
  await page
    .getByRole('button', { name: 'Pin test output…', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId(`rf__node-${nodeId}`)).toContainText('Pinned');
  await page.getByRole('button', { name: 'Paste JSON…', exact: true }).click();
  await page
    .getByLabel('Output (JSON)', { exact: true })
    .fill('{"proof":"pinned-data"}');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await selectStep(page, nodeId);
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const acceptedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/draft/nodes/${nodeId}/test`) &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Test with pinned output', exact: true })
    .click();
  const accepted = nodeTestExecuteAcceptedResponseSchema.parse(
    await (await acceptedResponse).json(),
  );
  expect(accepted.preview).toMatchObject({
    status: 'succeeded',
    pinnedSampleId: expect.any(String),
    startedAt: null,
    output: { kind: 'inline', value: { proof: 'pinned-data' } },
  });
  await expect(page.getByRole('region', { name: 'Last test' })).toContainText(
    'Pinned',
  );
  await page.getByRole('button', { name: 'Step actions', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Add step after', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a step after “Sample source”' })
    .getByRole('button', { name: /Set fields/u })
    .click();
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.length,
    )
    .toBe(2);
  const following = (
    await readEditorDraft(page, workflowPath)
  ).graph.nodes.find((step) => step.id !== nodeId);
  if (following === undefined) throw new Error('Following test step missing');
  await selectStep(page, following.id);
  await page.getByLabel('Label', { exact: true }).fill('Sample consumer');
  await page.keyboard.press('Tab');
  await mapProof(page);
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page
    .getByRole('switch', {
      name: 'Use the output from testing Sample source',
      exact: true,
    })
    .check();
  await page
    .getByRole('switch', {
      name: 'I understand this test runs for real',
      exact: true,
    })
    .check();
  await page.getByRole('button', { name: /^Run (?:another )?test$/u }).click();
  await expect(page.getByRole('group', { name: 'Test output' })).toContainText(
    'pinned-data',
  );
  await selectStep(page, nodeId);
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const pinPath = `${workflowPath}/draft/nodes/${nodeId}/sample`;
  const pinned = stepSampleResponseSchema.parse(
    await (await page.request.get(pinPath)).json(),
  );
  expect(pinned.sample?.state).toBe('pinned');
  const noCsrf = await request.put(pinPath, {
    data: {
      expectedDraftRevision: pinned.draftRevision,
      expectedSampleId: pinned.sample?.id,
      source: { kind: 'json', value: 'forbidden' },
    },
    headers: { 'Idempotency-Key': 'unauthenticated-pin' },
  });
  expect([401, 403]).toContain(noCsrf.status());
  const missingCsrf = await page.request.put(pinPath, {
    data: {
      expectedDraftRevision: pinned.draftRevision,
      expectedSampleId: pinned.sample?.id,
      source: { kind: 'json', value: 'forbidden' },
    },
    headers: { 'Idempotency-Key': 'missing-csrf-pin' },
  });
  expect(missingCsrf.status()).toBe(403);
  // The label is cosmetic. The mapping edit changes actual step behavior.
  await page.getByLabel('Label', { exact: true }).fill('Renamed sample source');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId(`rf__node-${nodeId}`)).toContainText('Pinned');
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page
    .getByRole('region', { name: 'Inputs', exact: true })
    .getByRole('button', { name: /^proof from/u })
    .click();
  await page.getByLabel('Run input path', { exact: true }).fill('$.different');
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Pinned sample' }),
  ).toContainText('Pin needs review');
  await expect(
    page.getByRole('button', { name: /^Run (?:another )?test$/u }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Confirm for this setup', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Test with pinned output', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Test with pinned output', exact: true })
    .click();
  await expect(page.getByRole('group', { name: 'Test output' })).toContainText(
    'pinned-data',
  );
  await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, {
    different: 'published-real',
    proof: 'published-following',
  });
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  const node = run.nodes.find((item) => item.nodeId === nodeId);
  if (node === undefined) throw new Error('Published run step missing');
  const output = workflowNodeRunOutputResponseSchema.parse(
    await (
      await page.request.get(
        `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${node.id}/output`,
      )
    ).json(),
  );
  expect(output.output).toEqual({
    kind: 'inline',
    value: { proof: 'published-real' },
  });
  await page.goto(editorUrl);
  await selectStep(page, nodeId);
  await page.getByRole('tab', { name: 'Runs', exact: true }).click();
  await page
    .getByRole('button', { name: 'Pin output…', exact: true })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Pin output', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const fromRun = stepSampleResponseSchema.parse(
    await (await page.request.get(pinPath)).json(),
  );
  expect(fromRun.sample?.source).toEqual({
    kind: 'run',
    runId,
    nodeRunId: node.id,
  });
  expect(fromRun.output).toEqual({ proof: 'published-real' });
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Remove pin', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Run (?:another )?test$/u }),
  ).toBeDisabled();
  expect(
    stepSampleResponseSchema.parse(
      await (await page.request.get(pinPath)).json(),
    ).sample,
  ).toBeNull();
});
