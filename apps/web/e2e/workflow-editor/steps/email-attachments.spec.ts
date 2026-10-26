import { openStepSetup } from '../../../test/support/browser/steps';
import { expect, test, type Page } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
} from '../support';

const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;

function uploaded(byteLength: number) {
  return {
    kind: 'artifact',
    artifactId: 'abababab-abab-4bab-8bab-abababababab',
    byteLength,
    mediaType: 'application/pdf',
    sha256: 'a'.repeat(64),
  };
}

function weeklyReport(attachments?: unknown) {
  return remoteDraft({
    nodes: [
      {
        id: 'create',
        label: 'Weekly report',
        definition: { key: 'core.create_file', version: 1 },
        configVersion: 1,
        config: { format: 'csv', delimiter: ',', columns: [] },
        inputMappings: { data: { kind: 'literal', value: [{ week: 42 }] } },
        connectionRefs: {},
        position: { x: 80, y: 80 },
      },
      {
        id: 'email',
        label: 'Email the report',
        definition: { key: 'email.send_notification', version: 1 },
        configVersion: 1,
        config: { timeoutMillis: 10_000 },
        inputMappings: {
          toEmail: { kind: 'literal', value: 'owner@example.com' },
          subject: { kind: 'literal', value: 'Weekly report' },
          text: { kind: 'literal', value: 'This week’s report is attached.' },
          ...(attachments === undefined
            ? {}
            : { attachments: { kind: 'literal', value: attachments } }),
        },
        connectionRefs: {},
        position: { x: 420, y: 80 },
      },
    ],
    edges: [
      {
        id: 'create-email',
        source: { nodeId: 'create', port: 'out' },
        target: { nodeId: 'email', port: 'in' },
      },
    ],
    settings: {},
  });
}

async function openInputs(page: Page, width: number) {
  await openStepSetup(page, { nodeId: 'email', width });
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  return page.getByRole('region', { name: 'Attachments', exact: true });
}

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 1440])
    test(`attaches a Create file report to Send email in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await addCsrfCookie(context);
      const remote = weeklyReport();
      const saved = () =>
        parseWorkflowGraphDraft(remote.graph).nodes.find(
          (node) => node.id === 'email',
        )?.inputMappings;
      await installEditorRoutes(page, remote, { definitions });
      await page.goto(editorUrl);
      const attachments = await openInputs(page, width);
      await expect(
        attachments.getByText('Attach a file from an earlier step'),
      ).toBeVisible();
      await expect(
        attachments.getByRole('meter', { name: 'Attachment size' }),
      ).toHaveAttribute('aria-valuetext', 'No files · up to 6 MB');
      // The message rows stay as they were; attachments are not a raw row.
      await expect(
        page.getByRole('button', { name: /^attachments/u }),
      ).toHaveCount(0);

      await attachments.getByRole('button', { name: 'Attach a file' }).click();
      await page
        .getByRole('dialog', { name: 'Attach a file' })
        .getByRole('button', { name: 'file from Weekly report' })
        .click();
      await expect(
        attachments.getByText('Named from its type when sent'),
      ).toBeVisible();
      await expect(
        attachments.getByText('from Weekly report › file'),
      ).toBeVisible();
      await expect
        .poll(() => saved()?.attachments)
        .toEqual({
          kind: 'expression',
          language: 'jsonata',
          expression: '[\n  {"file": (nodeOutputs."create"."file")}\n]',
        });

      await attachments
        .getByRole('button', { name: 'Edit attachment 1' })
        .click();
      await attachments
        .getByRole('textbox', { name: 'Name in the email' })
        .fill('weekly-report.csv');
      await expect
        .poll(() => saved()?.attachments)
        .toMatchObject({
          expression:
            '[\n  {"file": (nodeOutputs."create"."file"), "filename": "weekly-report.csv"}\n]',
        });
      await expect(
        attachments.getByRole('meter', { name: 'Attachment size' }),
      ).toHaveAttribute(
        'aria-valuetext',
        '1 file · 0 B of 6 MB · 1 measured when sent',
      );
      expect(saved()).toMatchObject({
        toEmail: { kind: 'literal', value: 'owner@example.com' },
        subject: { kind: 'literal', value: 'Weekly report' },
      });

      await page.reload();
      const reloaded = await openInputs(page, width);
      await expect(reloaded.getByText('weekly-report')).toBeVisible();
      await reloaded
        .getByRole('button', { name: 'Remove weekly-report.csv' })
        .click();
      await expect.poll(() => saved()?.attachments).toBeUndefined();
      await expect(
        reloaded.getByText('Attach a file from an earlier step'),
      ).toBeVisible();
      const notice = page.getByRole('region', { name: 'Notifications' });
      await expect(notice.getByText('Removed weekly-report.csv')).toBeVisible();
      await notice.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(() => saved()?.attachments).toBeDefined();
    });

test('measures uploaded files against the email size limit', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addCsrfCookie(context);
  const remote = weeklyReport([
    { file: uploaded(4_823_449), filename: 'Terms.pdf' },
  ]);
  await installEditorRoutes(page, remote, { definitions });
  await page.goto(editorUrl);
  const attachments = await openInputs(page, 1440);
  await expect(attachments.getByText('Uploaded file')).toBeVisible();
  await expect(
    attachments.getByRole('meter', { name: 'Attachment size' }),
  ).toHaveAttribute('aria-valuetext', '1 file · 4.6 MB of 6 MB');
  remote.graph = weeklyReport([
    { file: uploaded(4_823_449), filename: 'Terms.pdf' },
    { file: uploaded(2_097_152) },
  ]).graph;
  remote.revision += 1;
  await page.reload();
  const over = await openInputs(page, 1440);
  await expect(
    over.getByRole('meter', { name: 'Attachment size' }),
  ).toHaveAttribute('aria-valuetext', '2 files · 6.6 MB of 6 MB');
  await expect(over.getByText('attachment-2.pdf')).toBeVisible();
});
