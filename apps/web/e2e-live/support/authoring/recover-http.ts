import { workflowRunStartResponseSchema } from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import { waitForRun } from './single-step';

/** Uses the ordinary replay and recovery controls against the owned HTTP target. */
export async function recoverOwnedHttp(
  page: Page,
  workspaceId: string,
  sourceRunId: string,
  httpId: string,
) {
  async function replay(marker: string) {
    await page.goto(`/w/${workspaceId}/runs/${sourceRunId}`);
    await page.getByRole('button', { name: 'Replay', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Replay this run',
      exact: true,
    });
    await dialog.getByLabel('Replay input (JSON)', { exact: true }).fill(
      JSON.stringify({
        execute: true,
        body: { encoding: 'utf8', value: JSON.stringify({ marker }) },
      }),
    );
    const acceptance = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/workspaces/${workspaceId}/runs/${sourceRunId}/replay`,
    );
    await dialog
      .getByRole('button', { name: 'Replay run', exact: true })
      .click();
    const response = await acceptance;
    expect(response.status()).toBe(202);
    const id = workflowRunStartResponseSchema.parse(await response.json()).run
      .id;
    await expect(page).toHaveURL(`/w/${workspaceId}/runs/${id}`);
    return id;
  }
  const failedRunId = await replay('recovery-once');
  const source = await waitForRun(page, workspaceId, failedRunId, 'failed');
  const target = source.nodes.find(({ nodeId }) => nodeId === httpId);
  expect(target).toMatchObject({ status: 'failed', currentAttemptNumber: 1 });
  await page.setViewportSize({ width: 375, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page
    .getByRole('button', { name: 'Retry from this step', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: 'Retry from this step',
    exact: true,
  });
  await expect(confirmation).toContainText('4 earlier steps reused');
  const confirm = confirmation.getByRole('button', {
    name: 'Retry anyway',
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await expect(confirmation.getByLabel('Replay input (JSON)')).toHaveCount(0);
  await confirmation.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  const requests: { key: string | undefined; body: string | null }[] = [];
  let recoveryRunId: string | undefined;
  const path = `/v1/workspaces/${workspaceId}/runs/${failedRunId}/recover`;
  await page.route(`**${path}`, async (route) => {
    requests.push({
      key: route.request().headers()['idempotency-key'],
      body: route.request().postData(),
    });
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    const accepted = workflowRunStartResponseSchema.parse(
      await response.json(),
    );
    recoveryRunId ??= accepted.run.id;
    expect(accepted.run.id).toBe(recoveryRunId);
    if (requests.length === 1) await route.abort('failed');
    else await route.fulfill({ response });
  });
  await confirm.click();
  const retry = page.getByRole('dialog', {
    name: 'Retry same request',
    exact: true,
  });
  await expect(retry).toBeVisible();
  await retry.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(retry).toBeHidden();
  await page
    .getByRole('group', { name: 'Run actions', exact: true })
    .getByRole('button', { name: 'Retry same request', exact: true })
    .click();
  await retry
    .getByRole('button', { name: 'Retry same request', exact: true })
    .click();
  if (recoveryRunId === undefined)
    throw new Error('Recovery acceptance missing');
  await expect(page).toHaveURL(`/w/${workspaceId}/runs/${recoveryRunId}`);
  expect(requests).toHaveLength(2);
  expect(requests[0]?.key).toBeDefined();
  expect(requests[1]).toEqual(requests[0]);
  const recovered = await waitForRun(
    page,
    workspaceId,
    recoveryRunId,
    'succeeded',
  );
  expect(recovered.run.recovery).toMatchObject({
    reusedCount: 4,
    effectRisk: 'possible_effects',
    effectsAcknowledged: true,
  });
  const copies = recovered.nodes.filter(({ reused }) => reused !== undefined);
  expect(copies).toHaveLength(4);
  for (const copy of copies)
    expect(copy).toMatchObject({
      currentAttemptNumber: 0,
      startedAt: null,
      completedAt: null,
    });
  expect(
    (await waitForRun(page, workspaceId, failedRunId, 'failed')).nodes,
  ).toEqual(source.nodes);
  await expect(page.getByText('4 earlier steps reused')).toBeVisible();
  const copiedStep = page.getByRole('button', { name: /Should send: Reused/u });
  await copiedStep.click();
  const details = page.getByRole('dialog', {
    name: 'Should send',
    exact: true,
  });
  await expect(details).toContainText('This step was not executed here');
  await expect(details).toContainText('No input was sent');
  await page.keyboard.press('Escape');
  async function retryUnknown(marker: string) {
    const originalId = await replay(marker);
    const original = await waitForRun(
      page,
      workspaceId,
      originalId,
      'outcome_unknown',
    );
    const unknownTarget = original.nodes.find((node) => node.nodeId === httpId);
    if (unknownTarget === undefined) throw new Error('Unknown target missing');
    expect(unknownTarget.currentAttemptNumber).toBe(1);
    const preview = await page.request.get(
      `/v1/workspaces/${workspaceId}/runs/${originalId}/recovery`,
    );
    expect(preview.status()).toBe(200);
    expect(await preview.json()).toMatchObject({
      kind: 'eligible',
      effectRisk: 'unknown_outcome',
      reusedCount: 4,
    });
    const cookie = await readCsrfToken(page, {
      missingMessage: 'CSRF context missing',
    });
    for (const acknowledgement of [{}, { acknowledgePossibleEffects: true }]) {
      const refused = await page.request.post(
        `/v1/workspaces/${workspaceId}/runs/${originalId}/recover`,
        {
          headers: {
            'x-csrf-token': cookie,
            'Idempotency-Key': randomUUID(),
          },
          data: {
            workflowVersionId: original.run.workflowVersionId,
            nodeRunId: unknownTarget.id,
            ...acknowledgement,
          },
        },
      );
      expect(refused.status()).toBe(409);
      expect(await refused.json()).toMatchObject({
        code: 'run.recovery_unavailable',
        reason: 'unknown_outcome_acknowledgement_required',
      });
    }
    await page
      .getByRole('button', { name: 'Retry from this step', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Retry from this step',
      exact: true,
    });
    await expect(dialog).toContainText(
      "We don't know whether this step reached the service. Retrying can repeat its effect.",
    );
    const confirm = dialog.getByRole('button', {
      name: 'Retry anyway',
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    const checkbox = dialog.getByRole('checkbox');
    await expect(checkbox).not.toBeChecked();
    await checkbox.focus();
    await page.keyboard.press('Space');
    const acceptance = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/workspaces/${workspaceId}/runs/${originalId}/recover`,
    );
    await confirm.click();
    const response = await acceptance;
    expect(response.status()).toBe(202);
    const accepted = workflowRunStartResponseSchema.parse(
      await response.json(),
    );
    const result = await waitForRun(
      page,
      workspaceId,
      accepted.run.id,
      'succeeded',
    );
    expect(result.run).toMatchObject({
      workflowVersionId: original.run.workflowVersionId,
      replaySourceRunId: originalId,
      recovery: {
        reusedCount: 4,
        effectRisk: 'unknown_outcome',
        effectsAcknowledged: true,
      },
    });
    const copies = result.nodes.filter((node) => node.reused !== undefined);
    expect(copies).toHaveLength(4);
    for (const copy of copies)
      expect(copy).toMatchObject({
        currentAttemptNumber: 0,
        startedAt: null,
        completedAt: null,
      });
    expect(
      (await waitForRun(page, workspaceId, originalId, 'outcome_unknown'))
        .nodes,
    ).toEqual(original.nodes);
    return { originalId, recoveredId: result.run.id };
  }
  // Each journey navigates the same page and consumes the owned service state.
  const results: { originalId: string; recoveredId: string }[] = [];
  for (const marker of ['recovery-unknown', 'recovery-network-loss'])
    results.push(await retryUnknown(marker));
  const [unknown, network] = results;
  if (unknown === undefined || network === undefined)
    throw new Error('Unknown recovery evidence missing');
  return {
    failedRunId,
    recoveryRunId,
    unknownRunId: unknown.originalId,
    unknownRecoveryRunId: unknown.recoveredId,
    networkRunId: network.originalId,
    networkRecoveryRunId: network.recoveredId,
    recoveryKey: requests[0]?.key,
  };
}
