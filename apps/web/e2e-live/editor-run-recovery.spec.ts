import { expect } from '@playwright/test';
import {
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from './support/single-step-authoring';

test('inspects a real failed Condition, replays its version and cancels a waiting run', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mailOrigin, 'Run recovery owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Run recovery qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Recover a failed Condition',
  );
  const workflowId = workflowPath.split('/')[5];
  if (workflowId === undefined) throw new Error('Workflow identifier missing');
  const conditionId = await addSingleStep(
    page,
    workflowPath,
    /Condition/u,
    'Replay gate',
  );
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('condition');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.condition');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ condition: { kind: 'run_input', path: '$.condition' } });
  const version = await publishSingleStep(page, workflowPath);
  const failedRunId = await startSingleStep(page, {
    condition: 'not-a-boolean',
  });
  const failed = await waitForRun(page, workspaceId, failedRunId, 'failed');
  expect(failed.run.workflowVersionId).toBe(version.id);
  expect(failed.nodes).toHaveLength(1);
  const failedNode = failed.nodes[0];
  if (failedNode === undefined) throw new Error('Failed node is missing');
  expect(failedNode).toMatchObject({
    nodeId: conditionId,
    status: 'failed',
    currentAttemptNumber: 1,
    safeErrorCode: 'execution.attempt_invalid',
  });
  const dataPath = `/v1/workspaces/${workspaceId}/runs/${failedRunId}/node-runs/${failedNode.id}`;
  const input = await page.request.get(`${dataPath}/input`);
  expect(input.status()).toBe(200);
  expect(
    workflowNodeRunInputResponseSchema.parse(await input.json()).input,
  ).toEqual({ kind: 'inline', value: { condition: 'not-a-boolean' } });
  const failedOutput = await page.request.get(`${dataPath}/output`);
  expect(failedOutput.status()).toBe(200);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await failedOutput.json()).output,
  ).toEqual({ kind: 'none' });
  // Real phone keyboard/focus behavior, not only overflow assertions. No live
  // screenshots/traces containing authentication data are persisted.
  await page.setViewportSize({ width: 390, height: 844 });
  const step = page.getByRole('button', {
    name: 'Replay gate: Failed',
    exact: true,
  });
  await expect(step).toBeVisible();
  await step.focus();
  await page.keyboard.press('Enter');
  const details = page.getByRole('dialog', {
    name: 'Replay gate',
    exact: true,
  });
  await expect(details).toBeVisible();
  await expect(details).toContainText('execution.attempt_invalid');
  await expect(details).toContainText('not-a-boolean');
  await expect(details).toContainText('This step didn’t return anything.');
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await expect(step).toBeFocused();
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const replay = page.getByRole('dialog', {
    name: 'Replay this run',
    exact: true,
  });
  await expect(
    replay.getByLabel('Replay input (JSON)', { exact: true }),
  ).toHaveValue(JSON.stringify({ condition: 'not-a-boolean' }, null, 2));
  await replay
    .getByLabel('Replay input (JSON)', { exact: true })
    .fill('{"condition":true}');
  const acceptedReplay = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/workspaces/${workspaceId}/runs/${failedRunId}/replay`,
  );
  const [replayResponse] = await Promise.all([
    acceptedReplay,
    replay.getByRole('button', { name: 'Replay run', exact: true }).click(),
  ]);
  expect(replayResponse.status()).toBe(202);
  const replayRunId = workflowRunStartResponseSchema.parse(
    await replayResponse.json(),
  ).run.id;
  expect(replayRunId).not.toBe(failedRunId);
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
  const recovered = await waitForRun(
    page,
    workspaceId,
    replayRunId,
    'succeeded',
  );
  expect(recovered.run).toMatchObject({
    workflowVersionId: version.id,
    replaySourceRunId: failedRunId,
    triggerType: 'replay',
  });
  expect(recovered.nodes).toHaveLength(1);
  const recoveredNode = recovered.nodes[0];
  if (recoveredNode === undefined) throw new Error('Replayed node missing');
  expect(recoveredNode).toMatchObject({
    nodeId: conditionId,
    status: 'succeeded',
    currentAttemptNumber: 1,
  });
  const output = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${replayRunId}/node-runs/${recoveredNode.id}/output`,
  );
  expect(output.status()).toBe(200);
  expect(
    workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
  ).toEqual({ kind: 'inline', value: { selectedPort: 'true' } });
  // Keep editor authoring on desktop; the real run commands below stay usable
  // on the phone. Existing mocked editor geometry covers each requested width.
  await page.setViewportSize({ width: 1280, height: 720 });
  const waitPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Cancel an actual Wait',
  );
  const waitWorkflowId = waitPath.split('/')[5];
  if (waitWorkflowId === undefined)
    throw new Error('Wait workflow identifier missing');
  const waitNodeId = await addSingleStep(
    page,
    waitPath,
    /^Wait\b/u,
    'Long wait',
  );
  await page
    .getByRole('textbox', { name: 'Wait for (in seconds)', exact: true })
    .fill('600');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, waitPath)).graph.nodes[0]?.config,
    )
    .toEqual({ durationSeconds: 600 });
  const waitVersion = await publishSingleStep(page, waitPath);
  const waitRunId = await startSingleStep(page, {});
  const waiting = await waitForRun(page, workspaceId, waitRunId, 'waiting');
  expect(waiting.run.workflowVersionId).toBe(waitVersion.id);
  expect(waiting.nodes).toHaveLength(1);
  expect(waiting.nodes[0]).toMatchObject({
    nodeId: waitNodeId,
    status: 'waiting',
    currentAttemptNumber: 1,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const runActions = page.getByRole('group', {
    name: 'Run actions',
    exact: true,
  });
  await runActions
    .getByRole('button', { name: 'Cancel run', exact: true })
    .click();
  const cancel = page.getByRole('dialog', {
    name: 'Cancel this run?',
    exact: true,
  });
  await cancel
    .getByRole('button', { name: 'Keep running', exact: true })
    .click();
  await expect(cancel).toBeHidden();
  expect(
    (await waitForRun(page, workspaceId, waitRunId, 'waiting')).run
      .cancelRequestedAt,
  ).toBeNull();
  await runActions
    .getByRole('button', { name: 'Cancel run', exact: true })
    .click();
  await cancel.getByRole('button', { name: 'Cancel run', exact: true }).click();
  const canceled = await waitForRun(page, workspaceId, waitRunId, 'canceled');
  expect(canceled.run.cancelRequestedAt).not.toBeNull();
  expect(canceled.nodes).toHaveLength(1);
  expect(canceled.nodes[0]).toMatchObject({
    nodeId: waitNodeId,
    status: 'canceled',
    currentAttemptNumber: 1,
  });
  await expect(cancel).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Cancel run', exact: true }),
  ).toHaveCount(0);
  const evidence = await request.post(`${mailOrigin}/evidence/run-recovery`, {
    data: {
      workspaceId,
      workflowId,
      workflowVersionId: version.id,
      conditionId,
      failedRunId,
      replayRunId,
      waitWorkflowId,
      waitVersionId: waitVersion.id,
      waitNodeId,
      waitRunId,
    },
  });
  expect(evidence.status()).toBe(204);
});
