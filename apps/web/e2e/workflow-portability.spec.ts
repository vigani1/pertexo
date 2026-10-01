import { expect, test } from '@playwright/test';
import { portableGraphDigest } from '@pertexo/contracts/schemas/workflow-portability';
import { workflowGraphSchema } from '@pertexo/contracts/schemas/workflow-authoring';
import { fixtureStatistics } from '../test/support/run-fixtures';
import {
  addCsrfCookie,
  currentEtag,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspace,
  workspaceId,
} from './workflow-editor-support';

const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const destinationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const graph = workflowGraphSchema.parse({
  schemaVersion: 1,
  nodes: [
    {
      id: 'sender',
      definition: { key: 'slack.send_message', version: 1 },
      position: { x: 0, y: 0 },
      configVersion: 1,
      config: { channel: 'C_PRIVATE', message: 'Private literal to review' },
      inputMappings: {
        text: {
          kind: 'expression',
          language: 'jsonata',
          expression: '$lookup(private)',
          policyVersion: 1,
        },
      },
      connectionRefs: {},
      label: 'Private source label',
    },
  ],
  edges: [],
  settings: {},
});
const manifest = {
  format: 'pertexo.workflow',
  formatVersion: 1,
  graph,
  requirements: {
    definitions: [{ key: 'slack.send_message', version: 1, configVersion: 1 }],
    selectionFingerprint: `node-select:v1:sha256:${'a'.repeat(64)}`,
  },
  connectionSlots: [
    {
      nodeId: 'sender',
      slot: 'slack_bot_token',
      providerKey: 'slack',
      authType: 'slack_bot_token',
    },
  ],
};
const connection = {
  id: connectionId,
  workspaceId,
  providerKey: 'slack',
  name: 'Destination Slack',
  authType: 'slack_bot_token',
  status: 'active',
  secretVersionId: 'abababab-abab-4bab-8bab-abababababab',
  health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
  createdAt: '2026-09-14T10:00:00.000Z',
  updatedAt: '2026-09-14T10:00:00.000Z',
};

test('reviews exact saved export and explicitly binds a mobile keyboard import with exact recovery', async ({
  context,
  page,
}) => {
  await addCsrfCookie(context);
  await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
  const remote = remoteDraft({ ...graph, settings: { ...graph.settings } });
  await installEditorRoutes(page, remote, {
    accessibleWorkspace: {
      ...workspace,
      capabilities: [...workspace.capabilities, 'workflow:create'],
    },
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/run-statistics?**`,
    (route) => route.fulfill({ json: fixtureStatistics() }),
  );
  await page.route(`**/v1/workspaces/${workspaceId}/runs?**`, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route(
    `**/v1/workspaces/${workspaceId}/failure-notification-destinations`,
    (route) => route.fulfill({ json: { items: [] } }),
  );
  const exports: { body: unknown; etag: string | undefined }[] = [];
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/export`,
    async (route) => {
      exports.push({
        body: route.request().postDataJSON() as unknown,
        etag: route.request().headers()['if-match'],
      });
      await route.fulfill({
        json: manifest,
        headers: { 'cache-control': 'private, no-store' },
      });
    },
  );
  await page.goto(editorUrl);
  await page.getByRole('button', { name: 'Export…', exact: true }).click();
  const exporting = page.getByRole('dialog', {
    name: 'Export workflow',
    exact: true,
  });
  const source = exporting.getByLabel('Complete saved source graph');
  await expect(source).toContainText('Private literal to review');
  await expect(source).toContainText('$lookup(private)');
  await expect(source).toContainText('Private source label');
  await expect(
    exporting.getByRole('button', { name: 'Download workflow JSON' }),
  ).toBeDisabled();
  await exporting.getByRole('checkbox').focus();
  await page.keyboard.press('Space');
  const downloaded = page.waitForEvent('download');
  await exporting
    .getByRole('button', { name: 'Download workflow JSON' })
    .click();
  expect((await downloaded).suggestedFilename()).toBe('pertexo-workflow.json');
  expect(exports).toEqual([
    {
      body: {
        source: { kind: 'draft' },
        reviewedGraphDigest: await portableGraphDigest(graph),
      },
      etag: currentEtag(remote),
    },
  ]);

  let releaseConnections!: () => void;
  const connectionGate = new Promise<void>((resolve) => {
    releaseConnections = resolve;
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections?**`,
    async (route) => {
      await connectionGate;
      await route.fulfill({ json: { items: [connection], nextCursor: null } });
    },
  );
  let previews = 0;
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/import/preview`,
    async (route) => {
      previews += 1;
      expect(route.request().postDataJSON() as unknown).toEqual({
        manifest,
        bindings: [{ nodeId: 'sender', slot: 'slack_bot_token', connectionId }],
      });
      await route.fulfill({
        json: {
          manifestDigest: 'a'.repeat(64),
          compatibilityFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
          compatible: true,
          issues: [],
          truncated: false,
          connectionSlots: manifest.connectionSlots,
        },
      });
    },
  );
  const attempts: { body: unknown; key: string | undefined }[] = [];
  let releaseImport!: () => void;
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/import`,
    async (route) => {
      attempts.push({
        body: route.request().postDataJSON() as unknown,
        key: route.request().headers()['idempotency-key'],
      });
      if (attempts.length === 1) {
        await importGate;
        await route.abort('failed');
      } else
        await route.fulfill({
          status: 201,
          json: { workflowId: destinationId },
        });
    },
  );
  await page.goto(`/w/${workspaceId}/workflows`);
  await page.getByRole('button', { name: 'Import workflow…' }).click();
  const importing = page.getByRole('dialog', {
    name: 'Import workflow',
    exact: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await importing.getByLabel('Workflow JSON file').setInputFiles({
    name: 'portable.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await expect(importing.getByLabel('Complete imported graph')).toContainText(
    'Private literal to review',
  );
  await importing.getByLabel('New workflow name').fill('Independent import');
  await expect(
    importing.getByRole('button', { name: 'Preview import' }),
  ).toBeDisabled();
  const binding = importing.getByRole('combobox', {
    name: 'sender · slack_bot_token',
  });
  await expect(binding).toContainText('Choose a connection');
  await expect(binding).toBeDisabled();
  releaseConnections();
  await expect(binding).toBeEnabled();
  await binding.focus();
  await expect(binding).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(binding).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('option', { name: 'Destination Slack' }),
  ).toBeVisible();
  await page.getByRole('option', { name: 'Destination Slack' }).click();
  await importing.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    importing.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  await importing
    .getByLabel('New workflow name')
    .fill('Explicit independent import');
  await expect(
    importing.getByRole('button', { name: 'Import unpublished draft' }),
  ).toBeDisabled();
  await importing.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    importing.getByRole('button', { name: 'Import unpublished draft' }),
  ).toBeEnabled();
  expect(previews).toBe(2);
  const bounds = await importing.boundingBox();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: 'test-results/workflow-portability-mobile.png',
  });
  await importing
    .getByRole('button', { name: 'Import unpublished draft' })
    .click();
  await expect.poll(() => attempts.length).toBe(1);
  await importing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(importing).toHaveCount(0);
  await page.getByRole('button', { name: 'Import workflow…' }).click();
  await expect(
    importing.getByRole('button', { name: 'Importing…' }),
  ).toBeDisabled();
  expect(attempts).toHaveLength(1);
  await importing.getByRole('button', { name: 'Cancel', exact: true }).click();
  releaseImport();
  await page.getByRole('button', { name: 'Import workflow…' }).click();
  await expect(
    importing.getByRole('button', { name: 'Retry exact import' }),
  ).toBeEnabled();
  await expect(importing.getByLabel('New workflow name')).toBeDisabled();
  await importing.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(importing).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('link', { name: 'Home', exact: true })
    .click();
  const guard = page.getByRole('dialog', {
    name: 'Resolve the import before leaving',
  });
  await expect(guard).toBeVisible();
  await expect(guard).toHaveCSS('opacity', '1');
  await expect(page).toHaveURL(`/w/${workspaceId}/workflows`);
  expect(attempts).toHaveLength(1);
  await page.screenshot({
    path: 'test-results/workflow-portability-recovery.png',
    animations: 'disabled',
  });
  await guard.getByRole('button', { name: 'Reopen import' }).click();
  await expect(
    importing.getByRole('button', { name: 'Retry exact import' }),
  ).toBeEnabled();
  await importing.getByRole('button', { name: 'Retry exact import' }).click();
  await expect(
    importing.getByRole('button', { name: 'Open imported workflow' }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  expect(attempts[0]?.body).toEqual({
    manifest,
    bindings: [{ nodeId: 'sender', slot: 'slack_bot_token', connectionId }],
    name: 'Explicit independent import',
    expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  });
  await importing.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(importing).toHaveCount(0);
  await page.getByRole('button', { name: 'Import workflow…' }).click();
  await expect(
    importing.getByRole('button', { name: 'Open imported workflow' }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(2);
  await expect(importing).toHaveCSS('opacity', '1');
  await importing
    .getByRole('button', { name: 'Start another import' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/workflow-portability-confirmed.png',
    animations: 'disabled',
  });
  await importing.getByRole('button', { name: 'Start another import' }).click();
  await expect(importing.getByLabel('New workflow name')).toBeEnabled();
  await expect(importing.getByLabel('New workflow name')).toHaveValue('');
  await expect(importing.getByLabel('Workflow JSON file')).toHaveValue('');
  await expect(importing.getByLabel('Complete imported graph')).toHaveCount(0);
  await expect(
    importing.getByRole('button', { name: 'Import unpublished draft' }),
  ).toBeDisabled();
  expect(attempts).toHaveLength(2);
  await importing.getByLabel('Workflow JSON file').setInputFiles({
    name: 'second.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(manifest)),
  });
  await expect(importing.getByLabel('Complete imported graph')).toBeVisible();
  await importing
    .getByLabel('New workflow name')
    .fill('Deliberate second draft');
  await expect(binding).toBeEnabled();
  await expect(binding).toContainText('Choose a connection');
  await binding.focus();
  await page.keyboard.press('Enter');
  await page
    .getByRole('option', { name: 'Destination Slack', exact: true })
    .click();
  await importing.getByRole('button', { name: 'Preview import' }).click();
  await expect(
    importing.getByText(/Compatible with this workspace/u),
  ).toBeVisible();
  expect(attempts).toHaveLength(2);
  await importing
    .getByRole('button', { name: 'Import unpublished draft' })
    .click();
  await expect(
    importing.getByRole('button', { name: 'Open imported workflow' }),
  ).toBeEnabled();
  expect(attempts).toHaveLength(3);
  expect(attempts[2]?.key).toBeTruthy();
  expect(attempts[2]?.key).not.toBe(attempts[0]?.key);
  expect(attempts[2]?.body).toEqual({
    manifest,
    bindings: [{ nodeId: 'sender', slot: 'slack_bot_token', connectionId }],
    name: 'Deliberate second draft',
    expectedCompatibilityFingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
  });
  await importing.getByRole('button', { name: 'Close', exact: true }).click();
});
