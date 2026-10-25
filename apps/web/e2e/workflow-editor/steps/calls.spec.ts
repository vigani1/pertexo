import { expect, test } from '../../support/fixtures';
import { editorNode } from '../graph';
import {
  addCsrfCookie,
  definition,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowSummary,
  workspaceId,
} from '../support';

const childId = '11111111-1111-4111-8111-111111111111';
const firstId = '22222222-2222-4222-8222-222222222222';
const secondId = '33333333-3333-4333-8333-333333333333';
const callDefinition = {
  ...definition,
  definition: { key: 'core.call', version: 1 },
  family: 'logic',
  configSchema: { type: 'object', properties: { target: { type: 'object' } } },
  inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
};
const pin = {
  workflowId: childId,
  workflowVersionId: firstId,
  executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
};
const firstVersion = {
  id: firstId,
  workflowId: childId,
  versionNumber: 1,
  graph: {
    nodes: [],
    edges: [],
    settings: {},
    callable: {
      input: { type: 'string' },
      resultType: { type: 'string' },
      result: { kind: 'run_input', path: '$' },
    },
  },
  checksum: pin.executableChecksum,
  publishedAt: '2026-10-10T00:00:00.000Z',
};
const secondVersion = {
  ...firstVersion,
  id: secondId,
  versionNumber: 2,
  checksum: `wf:sha256:${'b'.repeat(64)}`,
};

test('browses Call versions on demand while retaining an old exact pin', async ({
  context,
  page,
}, testInfo) => {
  const remote = remoteDraft({
    nodes: [
      {
        ...editorNode('call', 'Reuse customer', '', 80),
        definition: callDefinition.definition,
        config: { target: pin },
        inputMappings: { input: { kind: 'literal', value: 'Ada' } },
      },
    ],
    edges: [],
    settings: {},
  });
  await addCsrfCookie(context);
  await installEditorRoutes(page, remote, { definitions: [callDefinition] });
  await page.route(`**/v1/workspaces/${workspaceId}/workflows?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...workflowSummary('Customer child', secondId).workflow,
            id: childId,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  const reads: string[] = [];
  let failOlderPage = true;
  await page.route(
    `**/v1/workspaces/${workspaceId}/workflows/${childId}/versions?**`,
    (route) => {
      const url = new URL(route.request().url());
      reads.push(url.search);
      const exact = url.searchParams.get('versionId');
      if (exact !== null)
        return route.fulfill({
          json: {
            items: [exact === firstId ? firstVersion : secondVersion],
            nextCursor: null,
          },
        });
      if (url.searchParams.has('after')) {
        if (failOlderPage) return route.abort();
        return route.fulfill({
          json: { items: [firstVersion], nextCursor: null },
        });
      }
      return route.fulfill({
        json: { items: [secondVersion], nextCursor: 'older-page' },
      });
    },
  );
  await page.goto(editorUrl);
  await page.getByTestId('rf__node-call').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('combobox', { name: 'Published version' }),
  ).toHaveText('Version 1');
  await expect(
    page.getByRole('button', { name: 'Upgrade to version 2' }),
  ).toBeVisible();
  expect(reads.some((search) => new URLSearchParams(search).has('after'))).toBe(
    false,
  );
  expect(new Set(reads).size).toBe(2);
  await page.getByRole('button', { name: 'Load more versions' }).click();
  await expect(
    page.getByText(
      'More versions couldn’t be loaded. The ones above are unchanged.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Published version' }),
  ).toHaveText('Version 1');
  failOlderPage = false;
  await page.getByRole('button', { name: 'Retry next page' }).click();
  await expect(
    page.getByRole('button', { name: 'Load more versions' }),
  ).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Published version' }).click();
  await expect(
    page.getByRole('option', { name: 'Version 1', exact: true }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(remote.graph.nodes[0]).toMatchObject({ config: { target: pin } });
  await page.screenshot({
    path: testInfo.outputPath('call-version-picker.png'),
  });
  await page.getByRole('button', { name: 'Upgrade to version 2' }).click();
  await expect
    .poll(() => remote.graph.nodes[0])
    .toMatchObject({
      config: {
        target: {
          ...pin,
          workflowVersionId: secondId,
          executableChecksum: secondVersion.checksum,
        },
      },
    });
});
