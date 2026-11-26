import { writeFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  draftProposalResultSchema,
  workflowNodeRunOutputResponseSchema,
} from '@pertexo/contracts';
import {
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../../support/authoring/single-step';
import { connectModel } from './model-editor';
import type { openModelProvider } from './model-provider';

const manual = {
  id: 'order-start',
  label: 'Start order intake',
  definition: { key: 'core.manual', version: 1 },
  configVersion: 1,
  position: { x: 0, y: 0 },
  config: {},
  inputMappings: {},
  connectionRefs: {},
};
const prepare = {
  ...manual,
  id: 'prepare-order',
  label: 'Prepare order',
  definition: { key: 'core.set', version: 2 },
  position: { x: 300, y: 0 },
};
export const orderDraft = {
  nodes: [manual, prepare] as const,
  edges: [
    {
      id: 'order-start-prepare',
      source: { nodeId: manual.id, port: 'out' },
      target: { nodeId: prepare.id, port: 'in' },
    },
  ],
  settings: {},
};
interface EvaluationRequest {
  description: string;
  inference: Awaited<ReturnType<typeof openModelProvider>>;
  info: TestInfo;
  path: string;
  modelName: string;
  allowPublicationIssues?: true;
}

export async function reviewAndApply(page: Page, options: EvaluationRequest) {
  const before = await readEditorDraft(page, options.path);
  const result = await requestProposal(page, options);
  expect(result).toMatchObject({
    kind: 'inspected',
    ...(options.allowPublicationIssues ? {} : { validation: { valid: true } }),
  });
  expect(await readEditorDraft(page, options.path)).toEqual(before);
  const review = page.getByRole('dialog', { name: 'Review proposed draft' });
  await review.getByRole('button', { name: 'Apply to draft' }).click();
  await expect(review).toBeHidden();
  if (result.kind !== 'inspected')
    throw new Error('Expected an inspected draft');
  await expect
    .poll(async () => (await readEditorDraft(page, options.path)).graph)
    .toEqual(result.draft.graph);
}

export async function requestProposal(
  page: Page,
  { description, inference, info, path, modelName }: EvaluationRequest,
) {
  const dialog = await openProposal(page, description);
  const response = page.waitForResponse(
    (message) =>
      message.request().method() === 'POST' &&
      new URL(message.url()).pathname === `${path}/draft/proposal`,
  );
  const started = performance.now();
  await dialog.getByRole('button', { name: 'Send to model' }).click();
  const result = draftProposalResultSchema.parse(await (await response).json());
  const metricsPath = info.outputPath('proposal-metrics.json');
  await writeFile(
    metricsPath,
    JSON.stringify(
      {
        model: modelName,
        elapsedMillis: Math.round(performance.now() - started),
        outcome: result.kind,
        ...('rounds' in result
          ? { rounds: result.rounds, usage: result.usage }
          : {}),
        requestBytes: inference.calls.map((call) =>
          Buffer.byteLength(JSON.stringify(call)),
        ),
      },
      null,
      2,
    ),
  );
  await info.attach('proposal metrics', {
    path: metricsPath,
    contentType: 'application/json',
  });
  return result;
}

export async function checkRouting(
  page: Page,
  workspace: string,
  path: string,
) {
  const editor = page.url();
  const { graph: applied } = await readEditorDraft(page, path);
  const flag = applied.nodes.find(
    ({ definition }) => definition.key === 'core.set',
  );
  if (flag === undefined) throw new Error('The result step is missing');
  await publishSingleStep(page, path);
  for (const [category, shouldRun] of [
    ['billing', true],
    ['sales', false],
  ] as const) {
    await page.goto(editor);
    const runId = await startSingleStep(page, { category });
    const { nodes } = await waitForRun(page, workspace, runId, 'succeeded');
    const flagged = nodes.find(({ nodeId }) => nodeId === flag.id);
    expect(flagged?.status === 'succeeded').toBe(shouldRun);
    if (shouldRun && flagged !== undefined) {
      const output = await page.request.get(
        `/v1/workspaces/${workspace}/runs/${runId}/node-runs/${flagged.id}/output`,
      );
      expect(output.ok()).toBe(true);
      expect(
        workflowNodeRunOutputResponseSchema.parse(await output.json()).output,
      ).toMatchObject({ kind: 'inline', value: { priority: 'high' } });
    }
  }
}

export async function connectAssistant(
  page: Page,
  workspace: string,
  modelName: string,
) {
  await connectModel(page, workspace);
  await page.goto(`/w/${workspace}/settings`);
  await page.getByLabel('AI connection', { exact: true }).click();
  await page.getByRole('option', { name: 'Order model', exact: true }).click();
  await page.getByLabel('Model identifier', { exact: true }).fill(modelName);
  await page.getByRole('button', { name: 'Save assistant settings' }).click();
  await expect(
    page.getByText('Assistant is on.', { exact: true }),
  ).toBeVisible();
}

export async function openProposal(page: Page, description: string) {
  await page
    .getByRole('button', { name: 'Ask assistant', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Describe your workflow change',
  });
  await expect(dialog).toContainText('model.provider.test');
  await expect(dialog).toContainText('step settings and input mappings');
  await dialog.getByLabel('What should the workflow do?').fill(description);
  return dialog;
}
