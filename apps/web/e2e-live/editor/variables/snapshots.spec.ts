import { readCsrfToken } from '../../../test/support/browser/csrf';
import '../data-tables/effects.case';
import '../data-tables/table.case';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import {
  pendingTaskListResponseSchema,
  workspaceVariablesResponseSchema,
  workflowRunVariablesResponseSchema,
} from '@pertexo/contracts';
import { inputRequestConfigSchema } from '@pertexo/workflow-model';
import { test } from '../../support/browser-fixture';
import {
  registerEditorUser,
  createEditorWorkspace,
} from '../../support/ordinary-editor-session';
import {
  createEditorWorkflow,
  publishSingleStep,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';

const node = (id: string, key: string, x: number) => ({
  id,
  definition: { key, version: 1 },
  configVersion: 1,
  config: {},
  inputMappings: {},
  connectionRefs: {},
  position: { x, y: 0 },
});
const edge = (source: string, target: string) => ({
  id: `${source}-${target}`,
  source: { nodeId: source, port: 'out' },
  target: { nodeId: target, port: 'in' },
});
test('real variables save once after a lost acknowledgement and retain old run values after edits', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Mail owner missing');
  await registerEditorUser(page, request, origin, 'Variable owner');
  const workspaceId = await createEditorWorkspace(
    page,
    'Variable qualification',
  );
  const variablePath = `/v1/workspaces/${workspaceId}/variables`;
  const variablePage = `/w/${workspaceId}/settings/variables`;
  await page.goto(variablePage);
  await page.getByRole('button', { name: 'Add variable', exact: true }).click();
  const row = page.getByRole('region', { name: 'New variable', exact: true });
  await row.getByLabel('Name', { exact: true }).fill('RATE');
  const rate = page.getByRole('region', { name: 'RATE', exact: true });
  await rate.getByLabel('Type', { exact: true }).selectOption('number');
  await rate.getByLabel('Value', { exact: true }).fill('10');
  await rate
    .getByLabel('Description (optional)', { exact: true })
    .fill('Rate applied to new invoices.');
  let intercepted = false;
  const writes: { body: string | null; key: string | undefined }[] = [];
  await page.route(`**${variablePath}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    writes.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    return route.fulfill({
      status: 502,
      json: {
        type: 'about:blank',
        title: 'Gateway lost response',
        status: 502,
        code: 'internal.error',
      },
    });
  });
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Retry same save', exact: true })
    .click();
  await expect(
    page.getByText('Saved revision 1 for new runs', { exact: true }),
  ).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  await page.unroute(`**${variablePath}`);
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Captured rate',
  );
  const graph = {
    settings: { maxRunDurationMs: 60000 },
    nodes: [
      node('manual', 'core.manual', 0),
      {
        ...node('input', 'core.request_input', 260),
        config: inputRequestConfigSchema.parse({
          title: 'Continue captured rate',
        }),
      },
      {
        ...node('finish', 'core.terminate', 520),
        inputMappings: { result: { kind: 'workspace_variable', name: 'RATE' } },
      },
    ],
    edges: [edge('manual', 'input'), edge('input', 'finish')],
  };
  const draft = await page.request.get(`${workflowPath}/draft`);
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  const version = await publishSingleStep(page, workflowPath);
  const source = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, source, 'waiting');
  await mkdir('/tmp/pertexo-variable-screenshots', { recursive: true });
  await page.goto(variablePage);
  await rate.getByRole('button', { name: 'Edit RATE', exact: true }).click();
  await rate.getByLabel('Value', { exact: true }).fill('20');
  await page
    .getByRole('button', { name: 'Save variables', exact: true })
    .click();
  await expect(
    page.getByText('Saved revision 2 for new runs', { exact: true }),
  ).toBeVisible();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width < 1024) {
      // Saving closed the row; reopen it to show the fields on a phone.
      await rate
        .getByRole('button', { name: 'Edit RATE', exact: true })
        .click();
      const description = rate.getByLabel('Description (optional)', {
        exact: true,
      });
      await description.scrollIntoViewIfNeeded();
      await description.click();
    }
    await page.screenshot({
      path: `/tmp/pertexo-variable-screenshots/settings-${String(width)}.png`,
      fullPage: width >= 1024,
    });
  }
  const current = workspaceVariablesResponseSchema.parse(
    await (await page.request.get(variablePath)).json(),
  );
  expect(current).toEqual({
    revision: 2,
    values: { RATE: 20 },
    descriptions: { RATE: 'Rate applied to new invoices.' },
  });
  async function finish(runId: string, expected: number) {
    let taskId = '';
    await expect
      .poll(async () => {
        const tasks = pendingTaskListResponseSchema.parse(
          await (
            await page.request.get(
              `/v1/workspaces/${workspaceId}/pending-tasks?view=all&status=pending&kind=input_request`,
            )
          ).json(),
        );
        taskId = tasks.items.find((item) => item.runId === runId)?.id ?? '';
        return taskId;
      })
      .not.toBe('');
    await page.goto(`/w/${workspaceId}/requests/${taskId}`);
    await page.getByLabel('Message', { exact: true }).fill('Continue');
    await page
      .getByRole('button', { name: 'Send response', exact: true })
      .click();
    await waitForRun(page, workspaceId, runId, 'succeeded');
    const snapshot = workflowRunVariablesResponseSchema.parse(
      await (
        await page.request.get(
          `/v1/workspaces/${workspaceId}/runs/${runId}/variables`,
        )
      ).json(),
    );
    expect(snapshot.snapshot?.values).toEqual({ RATE: expected });
    await page.goto(`/w/${workspaceId}/runs/${runId}`);
    await page
      .getByText('Workspace variables this run used', { exact: true })
      .click();
    await expect(
      page.getByText(
        `Captured at revision ${String(expected === 10 ? 1 : 2)} when the run started.`,
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Copy RATE', exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `/tmp/pertexo-variable-screenshots/run-${String(expected)}-${runId === source ? 'original' : 'next'}.png`,
      fullPage: true,
    });
  }
  await finish(source, 10);
  const replay = await page.request.post(
    `/v1/workspaces/${workspaceId}/runs/${source}/replay`,
    {
      headers: {
        'x-csrf-token': await readCsrfToken(page),
        'Idempotency-Key': randomUUID(),
      },
      data: { workflowVersionId: version.id, input: {} },
    },
  );
  expect(replay.status(), await replay.text()).toBe(202);
  const replayed = (await replay.json()) as { run: { id: string } };
  await finish(replayed.run.id, 10);
  const workflowId = workflowPath.split('/').at(-1);
  await page.setViewportSize({ width: 1280, height: 768 });
  await page.goto(`/w/${workspaceId}/workflows/${workflowId ?? ''}`);
  const fresh = await startSingleStep(page, {});
  await finish(fresh, 20);
});
