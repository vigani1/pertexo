import {
  dataTableResultSchema,
  nodeTestExecuteAcceptedResponseSchema,
  previewRunResponseSchema,
  stepSampleResponseSchema,
  workflowDraftResponseSchema,
  workflowTestAcceptedSchema,
  workflowTestDetailSchema,
  workflowTestPreparationSchema,
} from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readCsrfToken } from '../../../test/support/browser/csrf';
import {
  addSingleStep,
  createEditorWorkflow,
} from '../../support/authoring/single-step';
import { test } from '../../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
test('table writes require test consent, execute as real previews and are skipped by pins', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (origin === undefined) throw new Error('Use the owned fixture');
  await registerEditorUser(page, request, origin, 'Table effect owner');
  const workspaceId = await createEditorWorkspace(page, 'Table test effects');
  const csrf = await readCsrfToken(page, {
    missingMessage: 'Owned CSRF cookie missing',
  });
  const headers = () => ({
    'x-csrf-token': csrf,
    'Idempotency-Key': randomUUID(),
  });
  const tables = `/v1/workspaces/${workspaceId}/data-tables`;
  const created = await page.request.post(tables, {
    headers: headers(),
    data: {
      name: 'Events',
      columns: [
        { name: 'key', type: 'text', required: true },
        { name: 'amount', type: 'number', required: true },
      ],
      keyColumn: 'key',
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const tableId = ((await created.json()) as { id: string }).id;
  const path = await createEditorWorkflow(
    page,
    workspaceId,
    'Table test effects',
  );
  const nodeId = await addSingleStep(page, path, /Insert row/u, 'Write event');
  await expect
    .poll(
      async () =>
        (await readSavedDraft(page, path)).graph.nodes.find(
          (node) => node.id === nodeId,
        )?.label,
    )
    .toBe('Write event');
  const draft = await readSavedDraft(page, path);
  const graph = {
    ...draft.graph,
    nodes: draft.graph.nodes.map((node) => ({
      ...node,
      config: { table: 'Events' },
      inputMappings: {
        values: { kind: 'literal', value: { key: 'test', amount: 1 } },
      },
    })),
  };
  const saved = await page.request.put(`${path}/draft`, {
    headers: { ...headers(), 'If-Match': draft.representationTag },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  const readRows = async () => {
    const response = await page.request.post(
      `${tables}/${tableId}/rows/query`,
      { headers: headers(), data: { filters: [], limit: 100, offset: 0 } },
    );
    expect(response.status()).toBe(200);
    return dataTableResultSchema.parse(await response.json());
  };
  const preparedResponse = await page.request.get(
    `${path}/draft/tests/prepare`,
  );
  expect(preparedResponse.status()).toBe(200);
  const preparation = workflowTestPreparationSchema.parse(
    await preparedResponse.json(),
  );
  expect(preparation.effectfulSteps).toEqual([
    { nodeId, label: 'Write event' },
  ]);
  const noConsent = await page.request.post(`${path}/draft/tests`, {
    headers: headers(),
    data: {
      expectedRevision: preparation.draftRevision,
      expectedSamples: preparation.samples,
      expectedEffectfulSteps: [nodeId],
      input: {},
      acknowledgeSideEffects: false,
    },
  });
  expect(noConsent.status(), await noConsent.text()).toBe(422);
  expect((await readRows()).rows).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Test workflow', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Test workflow',
    exact: true,
  });
  await expect(
    dialog.getByRole('region', { name: 'Steps with effects', exact: true }),
  ).toContainText('Write event');
  await expect(
    dialog.getByRole('button', { name: 'Start test', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('switch', {
      name: 'I understand this test runs for real',
      exact: true,
    })
    .check();
  const acceptedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${path}/draft/tests`) &&
      response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Start test', exact: true }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(202);
  const run = workflowTestAcceptedSchema.parse(await accepted.json());
  await expect
    .poll(
      async () =>
        workflowTestDetailSchema.parse(
          await (
            await page.request.get(`${path}/draft/tests/${run.runId}`)
          ).json(),
        ).status,
      { timeout: 15_000 },
    )
    .toBe('succeeded');
  expect((await readRows()).rows[0]?.values).toEqual({
    key: 'test',
    amount: 1,
  });
  const current = await readSavedDraft(page, path);
  const previewGraph = {
    ...current.graph,
    nodes: current.graph.nodes.map((node) => ({
      ...node,
      inputMappings: {
        values: { kind: 'literal', value: { key: 'preview', amount: 2 } },
      },
    })),
  };
  const updated = await page.request.put(`${path}/draft`, {
    headers: { ...headers(), 'If-Match': current.representationTag },
    data: { graph: previewGraph },
  });
  expect(updated.status()).toBe(200);
  const fresh = await readSavedDraft(page, path);
  const previewBody = {
    mode: 'test_execute',
    expectedRevision: fresh.revision,
    input: { kind: 'manual', value: {} },
    acknowledgeSideEffects: true,
  };
  const refused = await page.request.post(
    `${path}/draft/nodes/${nodeId}/test`,
    {
      headers: headers(),
      data: { ...previewBody, acknowledgeSideEffects: false },
    },
  );
  expect(refused.status()).toBe(400);
  const previewResponse = await page.request.post(
    `${path}/draft/nodes/${nodeId}/test`,
    { headers: headers(), data: previewBody },
  );
  expect(previewResponse.status(), await previewResponse.text()).toBe(202);
  const preview = nodeTestExecuteAcceptedResponseSchema.parse(
    await previewResponse.json(),
  ).preview;
  expect(preview.disclosure).toMatchObject({
    mayContactProvider: false,
    mayCauseExternalSideEffect: true,
    sideEffectClass: 'idempotent_with_key',
  });
  const readPreview = async () =>
    previewRunResponseSchema.parse(
      await (
        await page.request.get(
          `/v1/workspaces/${workspaceId}/previews/${preview.id}`,
        )
      ).json(),
    ).preview;
  await expect
    .poll(async () => (await readPreview()).status, { timeout: 15_000 })
    .toBe('succeeded');
  const completed = await readPreview();
  if (completed.output?.kind !== 'inline')
    throw new Error('Table preview output missing');
  expect((await readRows()).rows).toHaveLength(2);
  const pinResponse = await page.request.put(
    `${path}/draft/nodes/${nodeId}/sample`,
    {
      headers: headers(),
      data: {
        expectedDraftRevision: fresh.revision,
        expectedSampleId: null,
        source: { kind: 'json', value: completed.output.value },
      },
    },
  );
  expect(pinResponse.status(), await pinResponse.text()).toBe(200);
  const pinnedSample = await page.request.get(
    `${path}/draft/nodes/${nodeId}/sample`,
  );
  expect(pinnedSample.status()).toBe(200);
  const pin = stepSampleResponseSchema.parse(await pinnedSample.json());
  expect(pin.sample?.state).toBe('pinned');
  const pinnedPreparation = workflowTestPreparationSchema.parse(
    await (await page.request.get(`${path}/draft/tests/prepare`)).json(),
  );
  expect(pinnedPreparation.effectfulSteps).toEqual([]);
  const pinnedResponse = await page.request.post(`${path}/draft/tests`, {
    headers: headers(),
    data: {
      expectedRevision: pinnedPreparation.draftRevision,
      expectedSamples: pinnedPreparation.samples,
      expectedEffectfulSteps: [],
      input: {},
      acknowledgeSideEffects: false,
    },
  });
  expect(pinnedResponse.status(), await pinnedResponse.text()).toBe(202);
  const pinned = workflowTestAcceptedSchema.parse(await pinnedResponse.json());
  await expect
    .poll(
      async () =>
        workflowTestDetailSchema.parse(
          await (
            await page.request.get(`${path}/draft/tests/${pinned.runId}`)
          ).json(),
        ).status,
      { timeout: 15_000 },
    )
    .toBe('succeeded');
  expect((await readRows()).rows).toHaveLength(2);
});

async function readSavedDraft(page: Page, path: string) {
  const response = await page.request.get(`${path}/draft`);
  expect(response.status()).toBe(200);
  const tag = response.headers().etag;
  if (tag === undefined) throw new Error('Draft ETag missing');
  return {
    ...workflowDraftResponseSchema.parse(await response.json()),
    representationTag: tag,
  };
}
