import { workflowRunStartResponseSchema } from '@pertexo/contracts';
import { mapBrowserInput } from '../../../test/support/browser/inputs';
import { test } from '../../support/browser-fixture';
import {
  addSingleStep,
  createEditorWorkflow,
  readEditorDraft,
  startSingleStep,
} from '../../support/authoring/single-step';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../../support/ordinary-editor-session';
import {
  expect,
  onlyVersion,
  publishNext,
  removeStep,
  runReaches,
} from './steps';

// Several real services behind one browser; this stays honest on a busy machine.
test.describe.configure({ timeout: 120_000 });

test('a failed run replays on the version that fixes it', async ({
  page,
  request,
}) => {
  const mail = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mail === undefined) throw new Error('Use the owned API fixture');
  await registerEditorUser(page, request, mail, 'Fix and replay owner');
  const workspaceId = await createEditorWorkspace(page, 'Fix and replay');
  const path = await createEditorWorkflow(page, workspaceId, 'Order gate');
  const editorUrl = new URL(page.url()).pathname;
  const conditionId = await addSingleStep(page, path, /Condition/u, 'Gate');
  await mapBrowserInput({
    page,
    field: 'condition',
    path: '$.wrong',
    source: 'Run input',
  });
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings,
    )
    .toEqual({ condition: { kind: 'run_input', path: '$.wrong' } });
  await publishNext(page, 1);
  const v1 = await onlyVersion(page, path);
  const failedRunId = await startSingleStep(page, { condition: true });
  const failed = await runReaches(page, workspaceId, failedRunId, 'failed');
  expect(failed.run.workflowVersionId).toBe(v1.id);

  await page.goto(editorUrl);
  await removeStep(page, path, conditionId);
  await addSingleStep(page, path, /Condition/u, 'Fixed gate');
  await mapBrowserInput({
    page,
    field: 'condition',
    path: '$.condition',
    source: 'Run input',
  });
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, path)).graph.nodes[0]?.inputMappings,
    )
    .toEqual({ condition: { kind: 'run_input', path: '$.condition' } });
  await publishNext(page, 2);

  await page.goto(`/w/${workspaceId}/runs/${failedRunId}`);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Replay this run',
    exact: true,
  });
  await expect(dialog.getByRole('radio', { name: /v2/u })).toBeChecked();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/${failedRunId}/replay`),
  );
  await dialog.getByRole('button', { name: 'Replay run', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  const started = workflowRunStartResponseSchema.parse(await response.json());
  const replayed = await runReaches(
    page,
    workspaceId,
    started.run.id,
    'succeeded',
  );
  expect(replayed.run.workflowVersionId).not.toBe(v1.id);
});
