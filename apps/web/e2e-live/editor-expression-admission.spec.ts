import { expect, type Request, type Response } from '@playwright/test';
import {
  strongEtagSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import {
  workflowNodeRunInputResponseSchema,
  workflowNodeRunOutputResponseSchema,
  workflowRunStartResponseSchema,
} from '@pertexo/contracts/schemas/workflow-runs';
import { test } from './support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from './support/ordinary-editor-session';
import {
  authorNestedExpressionGraph,
  readTaggedExpressionDraft,
} from './support/expression-editor-authoring';
import {
  createEditorWorkflow,
  startSingleStep,
  waitForRun,
} from './support/single-step-authoring';

function isPost(request: Request, path: string) {
  return (
    request.method() === 'POST' && new URL(request.url()).pathname === path
  );
}

test('real nested expression admission, guarded keyboard recovery and immutable execution', async ({
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Run through the owned API integration fixture');
  await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Expression admission owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Expression admission gate',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Nested expression admission',
  );
  const workflowId = workflowPath.split('/').at(-1);
  if (workflowId === undefined)
    throw new Error('Expression workflow ID missing');
  const validatePath = `${workflowPath}/validate`;
  const validationResponses: Response[] = [];
  const observeValidation = (response: Response) => {
    if (isPost(response.request(), validatePath))
      validationResponses.push(response);
  };
  page.on('response', observeValidation);
  try {
    const authored = await authorNestedExpressionGraph(page, workflowPath);
    const findingPath = `$.nodes.${authored.loopId}.structured.body.nodes.${authored.leafId}.inputMappings.expressionProof`;
    // Drain the actual automatic check for this exact saved tag first. It is
    // once per revision, so the explicit check below cannot capture an older
    // automatic request. No response is intercepted or synthesized.
    await expect
      .poll(
        () =>
          validationResponses.some(
            (response) =>
              response.status() === 200 &&
              response.headers().etag === authored.etag,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.getByRole('button', { name: '1 issue', exact: true }).click();
    const checkAgain = page.getByRole('button', {
      name: 'Check again',
      exact: true,
    });
    await expect(checkAgain).toBeEnabled();
    const invalidRequestPending = page.waitForRequest((outgoing) =>
      isPost(outgoing, validatePath),
    );
    await checkAgain.click();
    const invalidRequest = await invalidRequestPending;
    const invalidResponse = await invalidRequest.response();
    if (invalidResponse === null)
      throw new Error('Explicit validation response missing');
    expect(invalidResponse.status()).toBe(200);
    expect(strongEtagSchema.parse(invalidResponse.headers().etag)).toBe(
      authored.etag,
    );
    const invalid = workflowValidateResponseSchema.parse(
      await invalidResponse.json(),
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues).toEqual([
      {
        code: 'invalid_expression',
        path: findingPath,
        message: 'This expression is not valid restricted JSONata.',
      },
    ]);
    const fixName = 'Fix: This expression is not valid restricted JSONata.';
    await expect(
      page.getByRole('button', { name: fixName, exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Close issues', exact: true })
      .click();
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const publishDialog = page.getByRole('dialog', {
      name: 'Publish v1',
      exact: true,
    });
    await expect(
      publishDialog.getByRole('button', { name: 'Publish v1', exact: true }),
    ).toBeDisabled();
    await expect(
      publishDialog.getByText(
        'This expression is not valid restricted JSONata.',
        { exact: true },
      ),
    ).toBeVisible();
    await publishDialog
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    const unpublished = await page.request.get(`${workflowPath}/versions`);
    expect(unpublished.status()).toBe(200);
    expect(
      workflowVersionsResponseSchema.parse(await unpublished.json()).items,
    ).toEqual([]);

    await page.getByTestId(`rf__node-${authored.loopId}`).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    const limit = page.getByLabel('Maximum items', { exact: true });
    await limit.fill('-');
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: '1 issue', exact: true }).click();
    await page.getByRole('button', { name: fixName, exact: true }).click();
    const scratchDialog = page.getByRole('dialog', {
      name: 'Discard the unfinished edit?',
      exact: true,
    });
    await scratchDialog
      .getByRole('button', { name: 'Stay', exact: true })
      .click();
    await expect(limit).toHaveValue('-');
    expect((await readTaggedExpressionDraft(page, workflowPath)).etag).toBe(
      authored.etag,
    );
    await page.getByRole('button', { name: '1 issue', exact: true }).click();
    await page.getByRole('button', { name: fixName, exact: true }).click();
    await scratchDialog
      .getByRole('button', { name: 'Discard edit', exact: true })
      .click();
    await expect(page.getByLabel('Field', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Field', { exact: true })).toHaveValue(
      'expressionProof',
    );
    expect((await readTaggedExpressionDraft(page, workflowPath)).etag).toBe(
      authored.etag,
    );

    // Apply in the current inspector means completing the invalid scratch,
    // not an invented Apply button: complete values live-apply and save.
    await page.getByTestId(`rf__node-${authored.loopId}`).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await limit.fill('-');
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: '1 issue', exact: true }).click();
    await page.getByRole('button', { name: fixName, exact: true }).click();
    await scratchDialog
      .getByRole('button', { name: 'Stay', exact: true })
      .click();
    await limit.fill('2');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await readTaggedExpressionDraft(page, workflowPath)).draft.graph
            .nodes[0]?.structured?.maxIterations,
      )
      .toBe(2);
    const applied = await readTaggedExpressionDraft(page, workflowPath);
    expect(applied.etag).not.toBe(authored.etag);
    await page.getByRole('button', { name: '1 issue', exact: true }).click();
    await page.getByRole('button', { name: fixName, exact: true }).click();
    await expect(scratchDialog).not.toBeVisible();
    await expect(page.getByLabel('Field', { exact: true })).toBeFocused();
    await expect(
      page.getByRole('tab', { name: 'Inputs', exact: true }),
    ).toHaveAttribute('aria-selected', 'true');
    const expression = page.getByLabel('Expression', { exact: true });
    for (let index = 0; index < 6; index += 1) {
      if (
        await expression.evaluate(
          (element) => element === document.activeElement,
        )
      )
        break;
      await page.keyboard.press('Tab');
    }
    await expect(expression).toBeFocused();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText('runInput.amount > 5000');
    await page.keyboard.press('Tab');
    await expect
      .poll(
        async () =>
          (await readTaggedExpressionDraft(page, workflowPath)).draft.graph
            .nodes[0]?.structured?.body.nodes[0]?.inputMappings.expressionProof,
      )
      .toEqual({
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.amount > 5000',
        policyVersion: 1,
      });
    const corrected = await readTaggedExpressionDraft(page, workflowPath);
    expect(corrected.draft.revision).toBeGreaterThan(authored.draft.revision);
    expect(corrected.etag).not.toBe(authored.etag);
    // Auto validation may legitimately refresh before the UI is inspected.
    // Assert actual tag transitions, not an artificial stale-duration window.
    await expect
      .poll(
        () =>
          validationResponses.some(
            (response) =>
              response.status() === 200 &&
              response.headers().etag === corrected.etag,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    await page.getByRole('button', { name: 'No issues', exact: true }).click();
    await expect(checkAgain).toBeEnabled();
    const validRequestPending = page.waitForRequest((outgoing) =>
      isPost(outgoing, validatePath),
    );
    await checkAgain.click();
    const validResponse = await (await validRequestPending).response();
    if (validResponse === null)
      throw new Error('Corrected explicit validation response missing');
    expect(validResponse.status()).toBe(200);
    expect(strongEtagSchema.parse(validResponse.headers().etag)).toBe(
      corrected.etag,
    );
    expect(
      workflowValidateResponseSchema.parse(await validResponse.json()),
    ).toMatchObject({
      valid: true,
      issues: [],
      compatibility: { compatible: true, issues: [] },
    });
    await page
      .getByRole('button', { name: 'Close issues', exact: true })
      .click();
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const publishPending = page.waitForRequest((outgoing) =>
      isPost(outgoing, `${workflowPath}/publish`),
    );
    await publishDialog
      .getByRole('button', { name: 'Publish v1', exact: true })
      .click();
    const publishRequest = await publishPending;
    const publishResponse = await publishRequest.response();
    if (publishResponse === null)
      throw new Error('Observed publication response missing');
    expect(publishResponse.status()).toBe(200);
    expect(publishRequest.headers()['if-match']).toBe(corrected.etag);
    const published = workflowPublishResponseSchema.parse(
      await publishResponse.json(),
    );
    expect(published.version.graph).toEqual(corrected.draft.graph);
    await expect(page.getByText('v1 is live', { exact: true })).toBeVisible();
    const runPending = page.waitForRequest((outgoing) =>
      isPost(outgoing, `${workflowPath}/runs`),
    );
    const runId = await startSingleStep(page, {
      amount: 6000,
      items: ['north'],
    });
    const runRequest = await runPending;
    const runResponse = await runRequest.response();
    if (runResponse === null) throw new Error('Observed run response missing');
    expect(runResponse.status()).toBe(202);
    const accepted = workflowRunStartResponseSchema.parse(
      await runResponse.json(),
    );
    expect(accepted.run.id).toBe(runId);
    expect(accepted.run.workflowVersionId).toBe(published.version.id);
    const completed = await waitForRun(page, workspaceId, runId, 'succeeded');
    expect(completed.nodes).toHaveLength(2);
    expect(completed.nodes.every((node) => node.status === 'succeeded')).toBe(
      true,
    );
    const leaf = completed.nodes.find(
      (node) => node.nodeId === authored.leafId,
    );
    if (leaf === undefined)
      throw new Error('Completed expression leaf missing');
    const nodePath = `/v1/workspaces/${workspaceId}/runs/${runId}/node-runs/${leaf.id}`;
    const output = await page.request.get(`${nodePath}/output`);
    const input = await page.request.get(`${nodePath}/input`);
    expect(output.status()).toBe(200);
    expect(input.status()).toBe(200);
    const expectedPayload = {
      kind: 'inline',
      value: { item: 'north', expressionProof: true },
    };
    expect(
      workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
    ).toEqual(expectedPayload);
    expect(
      workflowNodeRunInputResponseSchema.parse(await input.json()).input,
    ).toEqual(expectedPayload);
    const evidence = await request.post(
      `${mailOrigin}/evidence/expression-admission`,
      {
        data: {
          workspaceId,
          workflowId,
          workflowVersionId: published.version.id,
          loopId: authored.loopId,
          leafId: authored.leafId,
          runId,
          publishKey: publishRequest.headers()['idempotency-key'],
          runKey: runRequest.headers()['idempotency-key'],
          invalidRevision: authored.draft.revision,
          correctedRevision: corrected.draft.revision,
          checkedEtag: corrected.etag,
        },
      },
    );
    expect(evidence.status()).toBe(204);
  } finally {
    page.off('response', observeValidation);
  }
});
