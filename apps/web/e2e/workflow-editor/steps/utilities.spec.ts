import { openStepSetup } from '../../../test/support/browser/steps';
import { expect, test } from '../../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import { parseWorkflowGraphDraft } from '@pertexo/workflow-model';
import { nodeDefinitionListResponseSchema } from '@pertexo/contracts';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workspaceId,
  workspace,
} from '../support';
const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;

for (const theme of ['light', 'dark'] as const)
  for (const width of [375, 990, 1440])
    test(`authors bounded utilities in ${theme} at ${String(width)}px`, async ({
      page,
      context,
    }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await addCsrfCookie(context);
      const remote = remoteDraft({
        nodes: [
          {
            id: 'format',
            label: 'Prepare message',
            definition: { key: 'core.text', version: 1 },
            configVersion: 1,
            config: { operation: 'trim' },
            inputMappings: { value: { kind: 'literal', value: ' a b ' } },
            connectionRefs: {},
            position: { x: 80, y: 80 },
          },
        ],
        edges: [],
        settings: {},
      });
      const saved = () => parseWorkflowGraphDraft(remote.graph).nodes[0];
      await installEditorRoutes(page, remote, { definitions });
      await page.goto(editorUrl);
      await openStepSetup(page, { nodeId: 'format', width: width });
      await page
        .getByRole('combobox', { name: 'Operation', exact: true })
        .click();
      await page
        .getByRole('option', { name: 'Truncate text', exact: true })
        .click();
      const length = page.getByLabel('Maximum characters', { exact: true });
      await length.fill('12');
      await expect
        .poll(() => saved()?.config)
        .toEqual({ operation: 'truncate', length: 12, ellipsis: true });
      await length.fill('');
      await expect(
        page.getByRole('combobox', { name: 'Operation', exact: true }),
      ).toBeDisabled();
      await length.fill('15');
      await length.blur();
      await page
        .getByRole('combobox', { name: 'Operation', exact: true })
        .click();
      await page
        .getByRole('option', { name: 'Replace text', exact: true })
        .click();
      await expect
        .poll(() => saved()?.config)
        .toEqual({ operation: 'replace', all: true });
      expect(saved()?.inputMappings).toEqual({
        value: { kind: 'literal', value: ' a b ' },
      });
      await page.reload();
      await openStepSetup(page, { nodeId: 'format', width: width });
      await expect(
        page.getByRole('combobox', { name: 'Operation', exact: true }),
      ).toHaveText('Replace text');
      await page.getByTestId('rf__node-format').focus();
      await page.screenshot({
        path: info.outputPath(`utilities-${theme}-${String(width)}.png`),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });

test('selects a Signing key connection for HMAC without exposing any key', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft({
    nodes: [
      {
        id: 'format',
        definition: { key: 'core.hmac', version: 1 },
        configVersion: 1,
        config: { algorithm: 'sha256', encoding: 'hex' },
        inputMappings: { value: { kind: 'literal', value: 'hello' } },
        connectionRefs: {},
        position: { x: 80, y: 80 },
      },
    ],
    edges: [],
    settings: {},
  });
  await installEditorRoutes(page, remote, { definitions });
  const id = '44444444-4444-4444-8444-444444444444';
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id,
            workspaceId,
            providerKey: 'signing',
            authType: 'hmac_key',
            name: 'Order signatures',
            status: 'active',
            secretVersionId: '55555555-5555-4555-8555-555555555555',
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: null,
            },
            createdAt: '2026-10-20T12:00:00Z',
            updatedAt: '2026-10-20T12:00:00Z',
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto(editorUrl);
  await openStepSetup(page, { nodeId: 'format', width: 1440 });
  await page
    .getByRole('combobox', { name: 'Signing key connection', exact: true })
    .click();
  await page
    .getByRole('option', { name: 'Order signatures', exact: true })
    .click();
  await expect
    .poll(() => parseWorkflowGraphDraft(remote.graph).nodes[0]?.connectionRefs)
    .toEqual({ hmac_key: id });
  await expect(page.getByText('SHA-256', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Signing key', { exact: true })).toHaveCount(0);
});

for (const scenario of [
  {
    key: 'core.xml',
    config: { operation: 'parse' },
    choice: 'JSON to XML',
    expected: { operation: 'build' },
  },
  {
    key: 'core.html',
    config: { operation: 'text', selector: 'a', limit: 100 },
    choice: 'Extract attribute',
    expected: {
      operation: 'attribute',
      selector: 'a',
      attribute: 'href',
      limit: 100,
    },
  },
  {
    key: 'core.crypto',
    config: { operation: 'hash', algorithm: 'sha256', encoding: 'hex' },
    choice: 'Random ID',
    expected: { operation: 'random_id', length: 24 },
  },
  {
    key: 'core.number',
    config: {
      operation: 'decimal',
      locale: 'en-US',
      grouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    },
    choice: 'Currency',
    expected: {
      operation: 'currency',
      locale: 'en-US',
      grouping: true,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
      currency: 'USD',
    },
  },
])
  test(`authors ${scenario.key} from its real catalog operation schema`, async ({
    page,
    context,
  }) => {
    await addCsrfCookie(context);
    const remote = remoteDraft({
      nodes: [
        {
          id: 'format',
          definition: { key: scenario.key, version: 1 },
          configVersion: 1,
          config: scenario.config,
          inputMappings: {},
          connectionRefs: {},
          position: { x: 80, y: 80 },
        },
      ],
      edges: [],
      settings: {},
    });
    await installEditorRoutes(page, remote, { definitions });
    await page.goto(editorUrl);
    await openStepSetup(page, { nodeId: 'format', width: 1440 });
    await page
      .getByRole('combobox', { name: 'Operation', exact: true })
      .click();
    await page
      .getByRole('option', { name: scenario.choice, exact: true })
      .click();
    await expect
      .poll(() => parseWorkflowGraphDraft(remote.graph).nodes[0]?.config)
      .toEqual(scenario.expected);
    if (scenario.key === 'core.html') {
      await page
        .getByRole('textbox', { name: 'Selector', exact: true })
        .fill('main > a');
      await page.getByRole('textbox', { name: 'Selector', exact: true }).blur();
      await expect
        .poll(
          () => parseWorkflowGraphDraft(remote.graph).nodes[0]?.config.selector,
        )
        .toBe('main > a');
    }
    if (scenario.key === 'core.crypto') {
      await page
        .getByRole('combobox', { name: 'Operation', exact: true })
        .click();
      await page
        .getByRole('option', { name: 'Hash text', exact: true })
        .click();
      await page
        .getByRole('combobox', { name: 'Algorithm', exact: true })
        .click();
      await expect(
        page.getByRole('option', {
          name: 'MD5 · not for security',
          exact: true,
        }),
      ).toBeVisible();
    }
  });

test('adds and checks an encrypted signing key in place, retaining exact whitespace and clearing the form', async ({
  page,
  context,
}) => {
  await addCsrfCookie(context);
  const remote = remoteDraft({
    nodes: [
      {
        id: 'format',
        definition: { key: 'core.hmac', version: 1 },
        configVersion: 1,
        config: { algorithm: 'sha256', encoding: 'hex' },
        inputMappings: { value: { kind: 'literal', value: 'hello' } },
        connectionRefs: {},
        position: { x: 80, y: 80 },
      },
    ],
    edges: [],
    settings: {},
  });
  await installEditorRoutes(page, remote, {
    definitions,
    accessibleWorkspace: {
      ...workspace,
      capabilities: [
        ...workspace.capabilities,
        'connection:use',
        'connection:manage',
      ],
    },
  });
  const id = '66666666-6666-4666-8666-666666666666';
  const connection = {
    id,
    workspaceId,
    providerKey: 'signing',
    authType: 'hmac_key',
    name: 'Orders HMAC',
    status: 'active',
    secretVersionId: '77777777-7777-4777-8777-777777777777',
    health: { lastTestedAt: null, lastHealthyAt: null, lastErrorCode: null },
    createdAt: '2026-10-20T12:00:00Z',
    updatedAt: '2026-10-20T12:00:00Z',
  };
  const key = '  browser-test-signing-key  ';
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        providerKey: 'signing',
        name: 'Orders HMAC',
        credential: { type: 'hmac_key', signingKey: key },
      });
      await route.fulfill({ status: 201, json: connection });
    },
  );
  let tests = 0;
  await page.route(
    `**/v1/workspaces/${workspaceId}/connections/${id}/test`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        providerKey: 'signing',
      });
      tests++;
      await route.fulfill({
        json: {
          connection: {
            ...connection,
            health: {
              lastTestedAt: '2026-10-20T12:00:00Z',
              lastHealthyAt: '2026-10-20T12:00:00Z',
              lastErrorCode: null,
            },
          },
          outcome: { ok: true, httpStatus: 200, errorCode: null },
        },
      });
    },
  );
  await page.goto(editorUrl);
  await openStepSetup(page, { nodeId: 'format', width: 1440 });
  await page
    .getByRole('button', { name: 'New Signing key connection', exact: true })
    .click();
  const lens = page.locator('[data-slot="sheet-content"]');
  const field = lens.getByLabel('Signing key', { exact: true });
  await expect(field).toHaveAttribute('type', 'password');
  await field.fill(key);
  await lens.getByRole('button', { name: 'Continue', exact: true }).click();
  await lens.getByLabel('Connection name', { exact: true }).fill('Orders HMAC');
  await lens
    .getByRole('button', { name: 'Save and test', exact: true })
    .click();
  await expect(
    lens.getByText('The signing key can be opened.', { exact: true }),
  ).toBeVisible();
  await expect(lens.getByText(key, { exact: true })).toHaveCount(0);
  await lens.getByRole('button', { name: 'Done', exact: true }).click();
  await expect
    .poll(
      () =>
        parseWorkflowGraphDraft(remote.graph).nodes[0]?.connectionRefs.hmac_key,
    )
    .toBe(id);
  expect(tests).toBe(1);
  await expect(page.getByLabel('Signing key', { exact: true })).toHaveCount(0);
});
