import {
  csrfToken,
  firstRunId,
  installRoutes,
  replayRunId,
  run,
  timestamp,
  workflowVersionId,
  workspaceId,
} from './fixture';

import { expect, test } from '../support/fixtures';

for (const width of [1280, 375])
  for (const risk of ['possible_effects', 'unknown_outcome'] as const)
    test(`confirms ${risk} saved-result recovery and shows reused history at ${String(width)}px`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 768 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.context().addCookies([
        {
          name: 'pertexo_csrf',
          value: csrfToken,
          url: 'http://127.0.0.1:4173',
        },
      ]);
      await installRoutes(page);
      const targetId = '22222222-2222-4222-8222-222222222222';
      const copyId = '33333333-3333-4333-8333-333333333333';
      const sourceCopyId = '44444444-4444-4444-8444-444444444444';
      const newTargetId = '55555555-5555-4555-8555-555555555555';
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: run(
                firstRunId,
                risk === 'unknown_outcome' ? 'outcome_unknown' : 'failed',
              ),
              nodes: [],
            },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/recovery`,
        (route) =>
          route.fulfill({
            json: {
              kind: 'eligible',
              workflowVersionId,
              versionNumber: 1,
              nodeRunId: targetId,
              nodeId: 'http',
              nodeLabel: 'Send request',
              reusedCount: 1,
              sourceCompletedAt: timestamp,
              effectRisk: risk,
            },
          }),
      );
      let posted: unknown;
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/recover`,
        (route) => {
          posted = route.request().postDataJSON();
          const { workflowName: _, ...accepted } = run(
            replayRunId,
            'succeeded',
          );
          return route.fulfill({
            status: 202,
            json: { run: accepted, replayed: false },
          });
        },
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${replayRunId}`,
        (route) =>
          route.fulfill({
            json: {
              run: {
                ...run(replayRunId, 'succeeded'),
                triggerType: 'replay',
                replaySourceRunId: firstRunId,
                recovery: {
                  targetNodeRunId: targetId,
                  targetNodeId: 'http',
                  reusedCount: 1,
                  effectRisk: risk,
                  effectsAcknowledged: true,
                },
              },
              nodes: [
                {
                  id: copyId,
                  nodeId: 'manual',
                  invocationKey: 'manual:0',
                  status: 'succeeded',
                  currentAttemptNumber: 0,
                  startedAt: null,
                  completedAt: null,
                  resumeAt: null,
                  safeErrorCode: null,
                  reused: {
                    sourceRunId: firstRunId,
                    sourceNodeRunId: sourceCopyId,
                    sourceCompletedAt: timestamp,
                  },
                },
                {
                  id: newTargetId,
                  nodeId: 'http',
                  invocationKey: 'http:0',
                  status: 'succeeded',
                  currentAttemptNumber: 1,
                  startedAt: timestamp,
                  completedAt: '2026-09-15T10:00:02.000Z',
                  resumeAt: null,
                  safeErrorCode: null,
                },
              ],
            },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${replayRunId}/node-runs/${copyId}/output`,
        (route) =>
          route.fulfill({ json: { output: { kind: 'inline', value: {} } } }),
      );
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await page
        .getByRole('button', { name: 'Retry from this step', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Retry from this step' });
      const ack = dialog.getByRole('checkbox');
      await expect(ack).not.toBeChecked();
      const confirm = dialog.getByRole('button', { name: 'Retry anyway' });
      await expect(confirm).toBeDisabled();
      await expect(dialog).toContainText(
        'Earlier steps use their saved results',
      );
      if (risk === 'unknown_outcome')
        await expect(dialog).toContainText(
          "We don't know whether this step reached the service. Retrying can repeat its effect.",
        );
      await ack.focus();
      await page.keyboard.press('Space');
      await expect(confirm).toBeEnabled();
      const box = await dialog.boundingBox();
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/recovery-confirmation-${risk}-${String(width)}.png`,
          fullPage: true,
        });
      await testInfo.attach(`recovery-confirmation-${risk}-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      await confirm.click();
      await expect(page).toHaveURL(`/w/${workspaceId}/runs/${replayRunId}`);
      expect(posted).toEqual({
        workflowVersionId,
        nodeRunId: targetId,
        ...(risk === 'unknown_outcome'
          ? { acknowledgeUnknownOutcome: true }
          : { acknowledgePossibleEffects: true }),
      });
      await expect(page.getByText('1 earlier step reused')).toBeVisible();
      await expect(
        width < 640
          ? page.getByRole('button', { name: 'manual: Reused', exact: true })
          : page.getByText('Reused', { exact: true }).first(),
      ).toBeVisible();
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/recovery-run-${risk}-${String(width)}.png`,
          fullPage: true,
        });
      await testInfo.attach(`recovery-run-${risk}-${String(width)}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
    });

for (const width of [1280, 375])
  test(`keeps handled failures visibly failed in successful history at ${String(width)}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installRoutes(page);
    const source = {
      id: '22222222-2222-4222-8222-222222222222',
      nodeId: 'source',
      invocationKey: 'source:0',
      status: 'failed',
      currentAttemptNumber: 1,
      startedAt: timestamp,
      completedAt: '2026-09-15T10:00:01.000Z',
      resumeAt: null,
      safeErrorCode: 'execution.authentication',
      failureHandling: {
        entryInvocationKey: 'handler:0',
        sinkInvocationKey: 'handler:0',
        disposition: 'handled',
      },
    };
    const handler = {
      ...source,
      id: '33333333-3333-4333-8333-333333333333',
      nodeId: 'handler',
      invocationKey: 'handler:0',
      status: 'succeeded',
      safeErrorCode: null,
    };
    const { failureHandling: _, ...ordinaryHandler } = handler;
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
      (route) =>
        route.fulfill({
          json: {
            run: { ...run(firstRunId, 'succeeded'), handledFailureCount: 1 },
            nodes: [source, ordinaryHandler],
          },
        }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/input`,
      (route) => route.fulfill({ json: { input: { kind: 'none' } } }),
    );
    await page.route(
      `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/output`,
      (route) => route.fulfill({ json: { output: { kind: 'none' } } }),
    );
    await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
    await expect(
      page.getByText('Finished — 1 failure handled', { exact: true }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: /source: Failed · failure handled/u })
      .click();
    const details =
      width < 640 ? page.getByRole('dialog') : page.getByLabel('Step details');
    await expect(details).toContainText(
      'The selected handler finished successfully. This source step remains failed.',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
      await page.screenshot({
        path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/failure-history-${String(width)}.png`,
        fullPage: true,
      });
    await testInfo.attach(`handled-failure-${String(width)}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
