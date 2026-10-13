import { expect, type Page } from '@playwright/test';
import { workflowRunStartResponseSchema } from '@pertexo/contracts';
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
  const unknownRunId = await replay('recovery-unknown');
  await waitForRun(page, workspaceId, unknownRunId, 'outcome_unknown');
  await expect(
    page.getByRole('button', { name: 'Retry from this step', exact: true }),
  ).toHaveCount(0);
  const preview = await page.request.get(
    `/v1/workspaces/${workspaceId}/runs/${unknownRunId}/recovery`,
  );
  expect(preview.status()).toBe(200);
  expect(await preview.json()).toEqual({
    kind: 'refused',
    reason: 'source_not_failed',
  });
  return {
    failedRunId,
    recoveryRunId,
    unknownRunId,
    recoveryKey: requests[0]?.key,
  };
}
