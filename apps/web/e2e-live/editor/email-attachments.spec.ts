import { connectionResponseSchema } from '@pertexo/contracts';
import { expect, type Page } from '@playwright/test';
import { readCsrfToken } from '../../test/support/browser/csrf';
import {
  createWorkflowEdgeFixture,
  createWorkflowNodeFixture,
} from '../../test/support/fixtures/graph';
import {
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from '../support/authoring/single-step';
import { test } from '../support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from '../support/ordinary-editor-session';

const csv = '"week","total"\r\n"42","1200"\r\n';

/** The ordinary Connections flow; the worker's Resend stand-in accepts any key. */
async function createResendConnection(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}/connections`);
  await page
    .getByRole('button', { name: 'Add connection', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Add a connection', exact: true })
    .getByRole('button', { name: 'Connect Email · Resend', exact: true })
    .click();
  const credential = page.getByRole('dialog', {
    name: 'Connect Email · Resend',
    exact: true,
  });
  await credential
    .getByLabel('Resend API key', { exact: true })
    .fill('re_owned_attachment_journey');
  await credential
    .getByLabel('From address', { exact: true })
    .fill('reports@example.com');
  await credential
    .getByRole('button', { name: 'Continue', exact: true })
    .click();
  await page
    .getByLabel('Connection name', { exact: true })
    .fill('Weekly report mail');
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname ===
        `/v1/workspaces/${workspaceId}/connections`,
  );
  await page
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const connection = connectionResponseSchema.parse(await response.json());
  await page.getByRole('button', { name: 'Skip test', exact: true }).click();
  return connection.id;
}

/** Manual start → Create file (CSV) → Send email, saved like any draft edit. */
async function saveReportWorkflow(
  page: Page,
  workflowPath: string,
  connectionId: string,
) {
  const draft = await page.request.get(`${workflowPath}/draft`);
  expect(draft.status()).toBe(200);
  const graph = {
    settings: { maxRunDurationMs: 60_000 },
    nodes: [
      createWorkflowNodeFixture({
        id: 'manual',
        definition: { key: 'core.manual', version: 1 },
        position: { x: 0, y: 0 },
      }),
      {
        ...createWorkflowNodeFixture({
          id: 'report',
          definition: { key: 'core.create_file', version: 1 },
          position: { x: 260, y: 0 },
        }),
        label: 'Weekly report',
        config: { format: 'csv', delimiter: ',', columns: [] },
        inputMappings: {
          data: { kind: 'literal', value: [{ week: 42, total: 1200 }] },
        },
      },
      {
        ...createWorkflowNodeFixture({
          id: 'email',
          definition: { key: 'email.send_notification', version: 1 },
          position: { x: 520, y: 0 },
        }),
        label: 'Email the report',
        config: { timeoutMillis: 10_000 },
        inputMappings: {
          toEmail: { kind: 'literal', value: 'owner@example.com' },
          subject: { kind: 'literal', value: 'Weekly report' },
          text: { kind: 'literal', value: 'This week’s report is attached.' },
        },
        connectionRefs: { resend_api_key: connectionId },
      },
    ],
    edges: [
      createWorkflowEdgeFixture({ source: 'manual', target: 'report' }),
      createWorkflowEdgeFixture({ source: 'report', target: 'email' }),
    ],
  };
  const saved = await page.request.put(`${workflowPath}/draft`, {
    headers: {
      'If-Match': draft.headers().etag ?? '',
      'x-csrf-token': await readCsrfToken(page),
    },
    data: { graph },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

test('attaches a Create file CSV in Send email and delivers it with the message', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Owned mail missing');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerEditorUser(page, request, mailOrigin, 'Report owner');
  const workspaceId = await createEditorWorkspace(page, 'Weekly reports');
  const connectionId = await createResendConnection(page, workspaceId);
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Email the weekly report',
  );
  await saveReportWorkflow(page, workflowPath, connectionId);
  await page.reload();

  await page.getByTestId('rf__node-email').click();
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  const attachments = page.getByRole('region', {
    name: 'Attachments',
    exact: true,
  });
  await attachments
    .getByRole('button', { name: 'Attach a file', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'file from Weekly report', exact: true })
    .click();
  await attachments
    .getByRole('button', { name: 'Edit attachment 1', exact: true })
    .click();
  await attachments
    .getByRole('textbox', { name: 'Name in the email', exact: true })
    .fill('weekly-report.csv');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes.find(
          ({ id }) => id === 'email',
        )?.inputMappings.attachments,
    )
    .toEqual({
      kind: 'expression',
      language: 'jsonata',
      expression:
        '[\n  {"file": (nodeOutputs."report"."file"), "filename": "weekly-report.csv"}\n]',
    });

  await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, {});
  await waitForRun(page, workspaceId, runId, 'succeeded');
  await page.goto(`/w/${workspaceId}/runs/${runId}`);
  await page
    .getByRole('button', { name: /Email the report/u })
    .first()
    .click();
  const sent = page.getByRole('region', { name: 'Attachments sent' });
  await expect(sent).toContainText('1 file sent');
  await expect(sent).toContainText('weekly-report.csv');

  // The delivered message itself carries the file Create file made.
  const delivered = await request.get(`${mailOrigin}/email-deliveries`);
  expect(delivered.status()).toBe(200);
  expect(await delivered.json()).toMatchObject({
    emails: [
      {
        to: 'owner@example.com',
        subject: 'Weekly report',
        attachments: [
          {
            filename: 'weekly-report.csv',
            contentType: 'text/csv; charset=utf-8',
            byteLength: Buffer.byteLength(csv),
            text: csv,
          },
        ],
      },
    ],
  });
});
