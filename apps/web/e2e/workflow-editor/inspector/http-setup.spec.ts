import { expect, test, type Page } from '../../support/fixtures';
import { workflowDraftResponseSchema } from '@pertexo/contracts';
import {
  httpMultipartConfigSchema,
  httpPaginationSchema,
} from '@pertexo/integrations';
import { platformBrowserNodeDefinitionCatalog } from '../../../../../packages/node-catalog/dist/index.js';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  user,
  workflowId,
  workspace,
  workspaceId,
  type RemoteDraft,
} from '../support';

const connectionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const httpDefinition = platformBrowserNodeDefinitionCatalog().definitions.find(
  ({ definition }) =>
    definition.key === 'http.request' && definition.version === 1,
);
if (httpDefinition === undefined)
  throw new Error('HTTP definition is required');

function httpDraft(maxResponseBytes = 1_048_576) {
  return remoteDraft({
    nodes: [
      {
        id: 'http',
        label: 'Fetch status',
        definition: { key: 'http.request', version: 1 },
        position: { x: 80, y: 80 },
        configVersion: 1,
        config: {
          method: 'GET',
          url: 'https://api.example.test/status',
          headers: { 'X-Trace': 'preserved' },
          timeoutMillis: 10_000,
          maxRedirects: 3,
          maxResponseBytes,
          inlineResponseBytes: 65_536,
        },
        inputMappings: {},
        connectionRefs: { http_headers: connectionId },
      },
    ],
    edges: [],
    settings: {},
  });
}

function savedHttpNode(remote: RemoteDraft) {
  const draft = workflowDraftResponseSchema.parse({
    workflowId,
    revision: remote.revision,
    graph: remote.graph,
    compatibility: {
      compatible: true,
      fingerprint: `wf-compat:sha256:${'a'.repeat(64)}`,
      issues: [],
    },
    updatedAt: user.updatedAt,
  });
  const node = draft.graph.nodes.find(({ id }) => id === 'http');
  if (node === undefined) throw new Error('HTTP step must remain in the draft');
  return node;
}

function savedConfig(remote: RemoteDraft) {
  return savedHttpNode(remote).config;
}

async function openSetup(page: Page, width: number) {
  await page.getByTestId('rf__node-http').click();
  if (width < 1024)
    await page
      .getByRole('navigation', { name: 'Editor panels' })
      .getByRole('button', { name: 'Step', exact: true })
      .click();
}

async function installHttp(page: Page, remote: RemoteDraft, editable = true) {
  await installEditorRoutes(page, remote, {
    definitions: [httpDefinition],
    accessibleWorkspace: {
      ...workspace,
      role: editable ? 'owner' : 'viewer',
      capabilities: editable
        ? [...workspace.capabilities, 'connection:use', 'connection:manage']
        : ['workspace:read', 'workflow:read', 'run:read', 'connection:read'],
    },
  });
  await page.route(`**/v1/workspaces/${workspaceId}/connections?**`, (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: connectionId,
            workspaceId,
            providerKey: 'http',
            name: 'Status API',
            authType: 'http_headers',
            status: 'active',
            secretVersionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            health: {
              lastTestedAt: null,
              lastHealthyAt: null,
              lastErrorCode: null,
            },
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
          },
        ],
        nextCursor: null,
      },
    }),
  );
}

for (const width of [390, 1280]) {
  test(`puts credentials first and saves human sizes without losing JSON settings at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = httpDraft();
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    const picker = page.getByLabel('HTTP connection', { exact: true });
    await expect(picker).toContainText('Status API');
    const pickerBox = await picker.boundingBox();
    const methodBox = await page
      .getByLabel('Method', { exact: true })
      .boundingBox();
    if (pickerBox === null || methodBox === null)
      throw new Error('Setup controls must be visible');
    expect(pickerBox.y + pickerBox.height).toBeLessThan(methodBox.y);
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    const inline = page.getByLabel('Store as a file above (in kilobytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1');
    await expect(inline).toHaveValue('64');
    await expect(page.getByText('That’s 1 MB. Up to 10 MB.')).toHaveCount(0);
    await response.fill('1.1');
    await expect(response).toBeFocused();
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(1_153_434);
    await inline.fill('64.001');
    await expect
      .poll(() => savedConfig(remote).inlineResponseBytes)
      .toBe(65_537);
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
    await page.reload();
    await openSetup(page, width);
    await expect(response).toHaveValue('1.1');
    await expect(inline).toHaveValue('64.001');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('2.1');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(2_202_010);
    await response.fill('11');
    await response.press('Tab');
    await expect(
      page.getByText('Largest response can be at most 10 MB.'),
    ).toBeVisible();
    expect(savedConfig(remote).maxResponseBytes).toBe(2_202_010);
    await response.fill('10');
    await page
      .getByRole('button', { name: 'Increase Largest response', exact: true })
      .click();
    await expect(response).toHaveValue('10');
    await expect
      .poll(() => savedConfig(remote).maxResponseBytes)
      .toBe(10_485_760);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });

  test(`preserves an odd byte count and readonly setup at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    const remote = httpDraft(1_048_577);
    await installHttp(page, remote, false);
    await page.goto(editorUrl);
    await openSetup(page, width);
    await expect(
      page.getByLabel('HTTP connection', { exact: true }),
    ).toBeDisabled();
    const response = page.getByLabel('Largest response (in megabytes)', {
      exact: true,
    });
    await expect(response).toHaveValue('1.000001');
    await expect(response).toBeDisabled();
    await expect(
      page.getByRole('button', {
        name: 'Increase Largest response',
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'New HTTP connection' }),
    ).toHaveCount(0);
    expect(savedConfig(remote).maxResponseBytes).toBe(1_048_577);
    expect(remote.revision).toBe(1);
  });
}

for (const width of [375, 1280]) {
  test(`keeps multipart values stable through reorder, cancel, undo and reload at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    const remote = httpDraft();
    const initial = savedHttpNode(remote);
    remote.graph = {
      ...remote.graph,
      nodes: [
        {
          ...initial,
          config: { ...initial.config, method: 'POST' },
          inputMappings: {
            body: {
              kind: 'literal',
              value: { encoding: 'utf8', value: 'original' },
            },
          },
        },
      ],
    };
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await page.getByRole('button', { name: 'Form parts', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(savedHttpNode(remote).inputMappings).toHaveProperty('body');
    await page.getByRole('button', { name: 'Form parts', exact: true }).click();
    await page.getByRole('button', { name: 'Replace', exact: true }).click();
    const first = page.getByRole('group', { name: /^Part 1:/u });
    await first.getByLabel('Field name', { exact: true }).fill('title');
    await first.getByLabel('Value', { exact: true }).fill('first');
    await page
      .getByRole('button', { name: 'Add text part', exact: true })
      .click();
    const second = page.getByRole('group', { name: /^Part 2:/u });
    await second.getByLabel('Field name', { exact: true }).fill('title');
    await second.getByLabel('Value', { exact: true }).fill('second');
    await expect
      .poll(() => JSON.stringify(savedHttpNode(remote).inputMappings))
      .toContain('second');
    const before = structuredClone(savedHttpNode(remote));
    const originalParts = httpMultipartConfigSchema.parse(
      before.config.multipart,
    ).parts;
    const reorderedParts = [originalParts[1], originalParts[0]];
    const readParts = () =>
      httpMultipartConfigSchema.parse(savedConfig(remote).multipart).parts;
    await second
      .getByRole('button', { name: 'Move part up', exact: true })
      .press('Enter');
    await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
      'second',
    );
    await expect(first.getByLabel('Field name', { exact: true })).toBeFocused();
    await expect.poll(readParts).toEqual(reorderedParts);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(readParts).toEqual(originalParts);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).focus();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
      'second',
    );
    await expect.poll(readParts).toEqual(reorderedParts);
    const secondKey = Object.entries(before.inputMappings).find(
      ([, value]) => value.kind === 'literal' && value.value === 'second',
    )?.[0];
    if (secondKey === undefined) throw new Error('Second value missing');
    await expect
      .poll(() => savedHttpNode(remote).inputMappings[secondKey])
      .toEqual({ kind: 'literal', value: 'second' });
    await page.getByRole('button', { name: 'Raw body', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
      'second',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await openSetup(page, width);
    await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
    await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
      'second',
    );
    await first
      .getByRole('button', { name: 'Remove part', exact: true })
      .click();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(first.getByLabel('Value', { exact: true })).toHaveValue(
      'first',
    );
    await expect(
      first.getByRole('button', { name: 'Remove part', exact: true }),
    ).toBeDisabled();
    await first.getByLabel('Field name', { exact: true }).fill('');
    let publishRequests = 0;
    page.on('request', (outgoing) => {
      if (
        outgoing.method() === 'POST' &&
        new URL(outgoing.url()).pathname.endsWith('/publish')
      )
        publishRequests++;
    });
    await page.getByRole('button', { name: 'Publish v1', exact: true }).click();
    const publish = page.getByRole('dialog', {
      name: 'Publish v1',
      exact: true,
    });
    await publish
      .getByRole('button', { name: 'Publish v1', exact: true })
      .click();
    await expect(
      publish.getByText(
        'Finish or discard the unfinished edit in the step panel first.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(publishRequests).toBe(0);
    await publish.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
      first.getByText(
        'Use a field name up to 128 UTF-8 bytes without control characters.',
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      httpMultipartConfigSchema
        .parse(savedConfig(remote).multipart)
        .parts.every(({ name }) => name === 'title'),
    ).toBe(true);
    await first.getByLabel('Field name', { exact: true }).fill('restored');
    await expect
      .poll(() =>
        httpMultipartConfigSchema
          .parse(savedConfig(remote).multipart)
          .parts.map(({ name }) => name),
      )
      .toEqual(['restored']);
  });
}

for (const width of [375, 1280]) {
  test(`configures each pagination mode and keeps its bounds at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const remote = httpDraft();
    await installHttp(page, remote);
    await page.goto(editorUrl);
    await openSetup(page, width);
    const section = page.locator('details').filter({
      has: page.locator('summary').filter({ hasText: 'Pagination' }),
    });
    await expect(section.locator('summary')).toHaveText('Pagination · Off');
    await expect(page.getByLabel('Items path', { exact: true })).toBeHidden();
    await section.locator('summary').click();
    const mode = page.getByLabel('Pagination mode', { exact: true });
    const choose = async (label: string) => {
      await mode.click();
      await page.getByRole('option', { name: label, exact: true }).click();
    };
    const saved = () =>
      httpPaginationSchema.safeParse(savedConfig(remote).pagination).data;
    await choose('Next page link');
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveValue('$.next');
    await page.getByLabel('Items path', { exact: true }).fill('records');
    await page.getByLabel('Max pages', { exact: true }).fill('3');
    await expect.poll(() => saved()?.itemsPath).toBe('$.records');
    await expect.poll(() => saved()?.maxPages).toBe(3);
    await expect(
      page.getByLabel('Largest page (in kilobytes)', { exact: true }),
    ).toHaveValue('64');
    await choose('Cursor');
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByLabel('Next cursor path', { exact: true }),
    ).toHaveValue('$.meta.next_cursor');
    await page.getByLabel('Query parameter', { exact: true }).fill('after');
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'cursor',
        parameter: 'after',
        itemsPath: '$.records',
        maxPages: 3,
      });
    await choose('Page number');
    await expect(
      page.getByLabel('Next cursor path', { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByLabel('First page', { exact: true })).toHaveValue(
      '1',
    );
    await choose('Offset');
    await expect(page.getByLabel('First offset', { exact: true })).toHaveValue(
      '0',
    );
    await page.getByLabel('Offset step', { exact: true }).fill('50');
    await page
      .getByLabel('Delay between pages (in seconds)', { exact: true })
      .fill('0.25');
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'offset',
        step: 50,
        delayMillis: 250,
        maxPages: 3,
      });
    await page.getByLabel('Max pages', { exact: true }).fill('0');
    await page.getByLabel('Max pages', { exact: true }).press('Tab');
    await expect(page.getByLabel('Max pages', { exact: true })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(saved()?.maxPages).toBe(3);
    await page.getByLabel('Max pages', { exact: true }).fill('3');
    await choose('Next page link');
    await page.getByLabel('Next link in', { exact: true }).click();
    await page
      .getByRole('option', { name: 'Link header', exact: true })
      .click();
    await expect(
      page.getByLabel('Next link path', { exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(() => saved())
      .toMatchObject({
        mode: 'next_link',
        source: { kind: 'link_header' },
        itemsPath: '$.records',
        maxPages: 3,
        delayMillis: 250,
      });
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.reload();
    await openSetup(page, width);
    await section.locator('summary').click();
    await expect(mode).toContainText('Next page link');
    await choose('Off');
    await expect.poll(() => savedConfig(remote).pagination).toBeUndefined();
    await expect(page.getByLabel('Items path', { exact: true })).toHaveCount(0);
    expect(savedConfig(remote).headers).toEqual({ 'X-Trace': 'preserved' });
  });
}
