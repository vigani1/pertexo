import { expect, test } from '../support/fixtures';
import { platformBrowserNodeDefinitionCatalog } from '../../../../packages/node-catalog/dist/index.js';
import {
  nodeDefinitionListResponseSchema,
  stepSampleWriteRequestSchema,
} from '@pertexo/contracts';
import {
  stepSampleIdentity,
  parseWorkflowGraphDraft,
} from '@pertexo/workflow-model';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from './support';
const definitions = nodeDefinitionListResponseSchema.parse({
  items: platformBrowserNodeDefinitionCatalog().definitions,
}).items;
const id = '11111111-1111-4111-8111-111111111111';
const limits = { inlineBytes: 262144, depth: 64, members: 10000 };
for (const width of [375, 1280])
  test(`captures and explicitly pins a webhook sample at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    const node = {
      id: 'incoming',
      label: 'Incoming event',
      definition: { key: 'core.webhook', version: 1 },
      configVersion: 1,
      config: {},
      inputMappings: {},
      connectionRefs: {},
      position: { x: 40, y: 0 },
    };
    const remote = remoteDraft({ nodes: [node], edges: [], settings: {} });
    await installEditorRoutes(page, remote, { definitions });
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
    let captured = false,
      pinned = false,
      stopped = false;
    const sample = () => {
      const current = parseWorkflowGraphDraft(remote.graph).nodes[0];
      if (current === undefined) throw new Error('Webhook step is missing');
      return pinned
        ? {
            id,
            nodeId: node.id,
            binding: stepSampleIdentity(current),
            state: 'pinned',
            source: { kind: 'webhook_test' },
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 2592000000).toISOString(),
          }
        : null;
    };
    await page.route(`${root}/samples`, (route) =>
      route.fulfill({
        json: {
          items: pinned ? [sample()] : [],
          draftRevision: remote.revision,
          limits,
        },
      }),
    );
    await page.route(`${root}/nodes/incoming/sample`, async (route) => {
      if (route.request().method() === 'PUT') {
        expect(
          stepSampleWriteRequestSchema.parse(route.request().postDataJSON()),
        ).toMatchObject({
          expectedSampleId: null,
          source: { kind: 'webhook_test', listenerId: id },
        });
        pinned = true;
        await route.fulfill({
          json: { sampleId: id, removed: false, replayed: false },
        });
      } else
        await route.fulfill({
          json: {
            sample: sample(),
            output: pinned ? { orderId: 17, amount: 24 } : null,
            draftRevision: remote.revision,
            limits,
          },
        });
    });
    await page.route(`${root}/nodes/incoming/webhook-test-events`, (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        expectedDraftRevision: remote.revision,
        authentication: { mode: 'secret_url', allowedOrigins: [] },
      });
      return route.fulfill({
        json: {
          id,
          path: `/hooks/${'a'.repeat(43)}/test`,
          authentication: { mode: 'secret_url', allowedOrigins: [] },
          expiresAt: new Date(Date.now() + 120000).toISOString(),
        },
      });
    });
    await page.route(
      `${root}/nodes/incoming/webhook-test-events/${id}`,
      (route) => {
        if (route.request().method() === 'DELETE') {
          stopped = true;
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({
          json: {
            state: captured ? 'captured' : 'waiting',
            expiresAt: new Date(Date.now() + 120000).toISOString(),
            output: captured
              ? {
                  kind: 'inline',
                  value: {
                    orderId: 17,
                    amount: 24,
                    nested: { child: { value: 1 } },
                  },
                }
              : null,
          },
        });
      },
    );
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-incoming').focus();
    await page.keyboard.press('Enter');
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Webhook test event' });
    await expect(panel.getByText('Receive a real sample')).toBeVisible();
    await panel
      .getByRole('heading', { name: 'Receive a real sample' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`webhook-listen-ready-${String(width)}.png`),
    });
    await panel.getByLabel('Test authentication').click();
    await page.getByRole('option', { name: 'Secret URL', exact: true }).click();
    await panel.getByRole('button', { name: 'Listen for test event' }).click();
    await expect(panel.getByText('Listening for one request…')).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Copy test URL' }),
    ).toBeInViewport();
    await panel
      .getByRole('heading', { name: 'Receive a real sample' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`webhook-listening-${String(width)}.png`),
    });
    captured = true;
    await expect(panel.getByText('Test event received')).toBeVisible();
    expect(pinned).toBe(false);
    const tree = panel.getByRole('group', { name: 'Received test data' });
    const outer = tree.locator('details').first();
    const nested = tree.locator('details').nth(1);
    const child = tree.locator('details').nth(2);
    const arrow = (details: typeof child) =>
      details.locator(':scope > summary > svg');
    await expect(arrow(outer)).toHaveCSS('rotate', '90deg');
    await expect(arrow(nested)).toHaveCSS('rotate', '90deg');
    await expect(arrow(child)).toHaveCSS('rotate', 'none');
    await child.locator(':scope > summary').click();
    await expect(arrow(child)).toHaveCSS('rotate', '90deg');
    await child.locator(':scope > summary').click();
    await expect(arrow(child)).toHaveCSS('rotate', 'none');
    await expect(arrow(nested)).toHaveCSS('rotate', '90deg');
    await expect(arrow(outer)).toHaveCSS('rotate', '90deg');
    await nested.locator(':scope > summary').click();
    await expect(arrow(nested)).toHaveCSS('rotate', 'none');
    await expect(arrow(outer)).toHaveCSS('rotate', '90deg');

    await panel.getByRole('button', { name: 'Keep as pinned sample' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Keep as pinned sample' })
      .click();
    await expect(panel.getByText('Kept as pinned sample')).toBeVisible();
    expect(pinned).toBe(true);
    await expect(
      page.getByText('From a captured request.', { exact: false }),
    ).toBeVisible();
    await panel
      .getByRole('heading', { name: 'Receive a real sample' })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath(`webhook-captured-${String(width)}.png`),
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await panel.getByRole('button', { name: 'Listen again' }).click();
    await expect(
      panel.getByRole('button', { name: 'Listen for test event' }),
    ).toBeVisible();
    expect(stopped).toBe(true);
    await expect(panel.getByLabel('Test authentication')).toContainText(
      'Secret URL',
    );
  });
