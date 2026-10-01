import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts/schemas/catalog';
import {
  workflowDraftResponseSchema,
  workflowInputCaseListResponseSchema,
  workflowPublishResponseSchema,
  workflowValidateResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunStartResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';
import { apiProblemSchema } from '@pertexo/contracts/schemas/errors';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  createEditorWorkflow,
  waitForRun,
} from './support/single-step-authoring';

test.afterEach(async ({ page }, info) => {
  if (info.status !== info.expectedStatus && !page.isClosed()) {
    await page.screenshot({
      path: info.outputPath('input-cases-failure.png'),
      fullPage: true,
    });
    await info.attach('rendered-input-cases', {
      body: await page.locator('body').innerText(),
      contentType: 'text/plain',
    });
  }
});

async function csrf(page: Page) {
  const cookie = (await page.context().cookies()).find(
    (item) => item.name === 'pertexo_csrf',
  );
  if (cookie === undefined) throw new Error('Ordinary CSRF cookie missing');
  return { 'x-csrf-token': decodeURIComponent(cookie.value) };
}

/** Every publication goes through the ordinary draft/validate/publish API. */
async function publish(page: Page, path: string, label: string) {
  const draft = await page.request.get(`${path}/draft`);
  expect(draft.status()).toBe(200);
  workflowDraftResponseSchema.parse(await draft.json());
  const catalogResponse = await page.request.get('/v1/node-definitions');
  expect(catalogResponse.status()).toBe(200);
  const catalog = nodeDefinitionListResponseSchema.parse(
    await catalogResponse.json(),
  );
  const definition = catalog.items
    .filter(
      (entry) =>
        entry.definition.key === 'core.set' &&
        entry.available &&
        entry.publishable,
    )
    .sort((a, b) => b.definition.version - a.definition.version)[0];
  if (definition === undefined)
    throw new Error('Live core.set catalog entry missing');
  // Presentation-only labels deduplicate; each revision changes executable identity.
  const nodeId = randomUUID();
  const saved = await page.request.put(`${path}/draft`, {
    headers: { ...(await csrf(page)), 'If-Match': draft.headers().etag ?? '' },
    data: {
      graph: {
        schemaVersion: 1,
        nodes: [
          {
            id: nodeId,
            definition: definition.definition,
            configVersion: definition.configVersion,
            config: {},
            inputMappings: { proof: { kind: 'run_input', path: '$.proof' } },
            connectionRefs: {},
            position: { x: 0, y: 0 },
            label,
          },
        ],
        edges: [],
        settings: {},
      },
    },
  });
  expect(saved.status()).toBe(200);
  const checked = await page.request.post(`${path}/validate`, {
    headers: await csrf(page),
    data: {},
  });
  expect(checked.status()).toBe(200);
  expect(workflowValidateResponseSchema.parse(await checked.json()).valid).toBe(
    true,
  );
  const published = await page.request.post(`${path}/publish`, {
    headers: {
      ...(await csrf(page)),
      'If-Match': checked.headers().etag ?? '',
      'Idempotency-Key': randomUUID(),
    },
    data: {},
  });
  expect(published.status()).toBe(200);
  return {
    versionId: workflowPublishResponseSchema.parse(await published.json())
      .version.id,
    nodeId,
  };
}

test('real cases CRUD, detached input, stale checked start and frozen accepted-command recovery', async ({
  page,
  request,
}, info) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined)
    throw new Error('Use the owned input-cases API browser fixture');
  await registerEditorUser(page, request, mailOrigin, 'Input cases owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Input cases qualification',
  );
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Input cases sender',
  );
  const workflowId = path.split('/').at(-1);
  if (workflowId === undefined) throw new Error('Workflow identity missing');
  const first = await publish(page, path, 'Initial input proof');
  await page.reload();
  await page.getByRole('button', { name: 'Input cases', exact: true }).click();
  const manager = page.getByRole('dialog', {
    name: 'Input cases',
    exact: true,
  });
  await manager.getByRole('button', { name: 'New input case' }).click();
  await manager.getByLabel('Case name', { exact: true }).fill('Original proof');
  await manager
    .getByLabel('Case input (JSON)', { exact: true })
    .fill('{"proof":"f02-real-input"}');
  await manager.getByRole('button', { name: 'Save input case' }).click();
  for (const name of ['Edited proof', 'Final original proof']) {
    await manager.getByRole('button', { name: /^Edit /u }).click();
    await manager.getByLabel('Case name', { exact: true }).fill(name);
    await manager.getByRole('button', { name: 'Save input case' }).click();
    await expect(
      manager.getByRole('button', { name: `Load ${name}`, exact: true }),
    ).toBeVisible();
  }
  const casesResponse = await page.request.get(`${path}/input-cases`);
  expect(casesResponse.status()).toBe(200);
  const original = workflowInputCaseListResponseSchema.parse(
    await casesResponse.json(),
  ).items[0];
  if (original === undefined) throw new Error('Created case missing');
  expect(original.revision).toBeGreaterThanOrEqual(3);
  await manager.getByRole('button', { name: 'Close input cases' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page
    .getByRole('menuitem', { name: 'Run with input…', exact: true })
    .click();
  const runDialog = page.getByRole('dialog', {
    name: 'Run with input',
    exact: true,
  });
  await runDialog
    .getByRole('button', { name: 'Load Final original proof' })
    .click();
  await expect(
    runDialog.getByLabel('Run input (JSON)', { exact: true }),
  ).toHaveValue(/f02-real-input/u);
  await page.screenshot({
    path: info.outputPath('input-cases-loaded-desktop.png'),
    fullPage: true,
  });
  const second = await publish(page, path, 'Second input proof');
  expect(second.versionId).not.toBe(first.versionId);
  const staleResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `${path}/runs`,
  );
  await runDialog
    .getByRole('button', { name: 'Start published version' })
    .click();
  const rejected = await staleResponse;
  expect(rejected.status()).toBe(409);
  expect(apiProblemSchema.parse(await rejected.json()).code).toBe(
    'workflow.published_version_conflict',
  );
  await expect(runDialog).toContainText('No run started');
  await runDialog
    .getByRole('button', { name: 'Edit Final original proof' })
    .click();
  await runDialog
    .getByRole('button', { name: 'Delete case', exact: true })
    .click();
  await runDialog
    .getByRole('button', { name: 'Confirm delete case', exact: true })
    .click();
  await expect(
    runDialog.getByRole('button', { name: 'Load Final original proof' }),
  ).toHaveCount(0);
  await expect(
    runDialog.getByLabel('Run input (JSON)', { exact: true }),
  ).toHaveValue(/f02-real-input/u);
  await runDialog
    .getByRole('button', {
      name: 'Read current publication and review copied input',
    })
    .click();
  await expect(
    runDialog.getByText(second.versionId, { exact: true }),
  ).toBeVisible();
  await expect(
    runDialog.getByRole('button', { name: 'New input case' }),
  ).toBeEnabled();
  await runDialog.getByRole('button', { name: 'New input case' }).click();
  await runDialog
    .getByLabel('Case name', { exact: true })
    .fill('Reviewed proof');
  await runDialog
    .getByLabel('Case input (JSON)', { exact: true })
    .fill('{"proof":"f02-real-input"}');
  await runDialog.getByRole('button', { name: 'Save input case' }).click();
  await runDialog.getByRole('button', { name: 'Load Reviewed proof' }).click();
  const replacementResponse = await page.request.get(`${path}/input-cases`);
  const replacement = workflowInputCaseListResponseSchema.parse(
    await replacementResponse.json(),
  ).items[0];
  if (replacement === undefined) throw new Error('Replacement case missing');
  expect(replacement.workflowVersionId).toBe(second.versionId);
  const submitted: { body: unknown; key: string | undefined }[] = [];
  let acceptedRunId: string | undefined;
  await page.route(`${path}/runs`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    submitted.push({
      body: route.request().postDataJSON() as unknown,
      key: route.request().headers()['idempotency-key'],
    });
    if (submitted.length !== 1) {
      await route.continue();
      return;
    }
    // The actual API accepts before only the browser response is lost.
    const accepted = await route.fetch();
    expect(accepted.status()).toBe(202);
    acceptedRunId = workflowRunStartResponseSchema.parse(await accepted.json())
      .run.id;
    await route.abort('failed');
  });
  await runDialog
    .getByRole('button', { name: 'Start published version' })
    .click();
  await expect(
    runDialog.getByRole('button', { name: 'Retry same run' }),
  ).toBeVisible();
  await expect(
    runDialog.getByLabel('Run input (JSON)', { exact: true }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 844 });
  // The modal hides outside toast buttons from the accessibility tree even
  // while they remain painted. Observe the real DOM and let ordinary success
  // notifications expire before claiming the recovery controls are unobscured.
  await page.mouse.move(0, 0);
  await expect(
    page.locator(
      '[data-slot="toast-viewport"] button[aria-label="Dismiss notification"]',
    ),
  ).toHaveCount(0, { timeout: 10_000 });
  const retryButton = runDialog.getByRole('button', { name: 'Retry same run' });
  await retryButton.scrollIntoViewIfNeeded();
  await retryButton.focus();
  await expect(retryButton).toBeFocused();
  await expect(retryButton).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('input-cases-recovery-mobile.png'),
    fullPage: true,
  });
  const third = await publish(page, path, 'Third input proof');
  expect(
    new Set([first.versionId, second.versionId, third.versionId]).size,
  ).toBe(3);
  await retryButton.click();
  await expect(page).toHaveURL(/\/runs\/[^/]+$/u);
  expect(submitted).toHaveLength(2);
  expect(submitted[1]).toEqual(submitted[0]);
  expect(submitted[0]?.body).toMatchObject({
    input: { proof: 'f02-real-input' },
    expectedPublishedVersionId: second.versionId,
  });
  const runId = new URL(page.url()).pathname.split('/')[4];
  expect(runId).toBe(acceptedRunId);
  if (runId === undefined) throw new Error('Accepted run identity missing');
  const run = await waitForRun(page, workspaceId, runId, 'succeeded');
  expect(run.run.workflowVersionId).toBe(second.versionId);
  await expect(
    page.getByRole('heading', { level: 1, name: /^Succeeded in/u }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath('input-cases-accepted-mobile.png'),
    fullPage: true,
  });
  const evidence = await request.post(`${mailOrigin}/input-cases-evidence`, {
    data: {
      workspaceId,
      workflowId,
      caseId: original.id,
      replacementCaseId: replacement.id,
      runId,
      workflowVersionId: second.versionId,
      nodeId: second.nodeId,
      originalWorkflowVersionId: first.versionId,
      currentPublishedVersionId: third.versionId,
    },
  });
  expect(evidence.status()).toBe(204);
});
