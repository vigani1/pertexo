import { chooseTestAction, expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';
const sampleId = '11111111-1111-4111-8111-111111111111';
for (const width of [375, 1280])
  test(`keeps edited test input while loading a trigger sample at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await addCsrfCookie(context);
    await installEditorRoutes(
      page,
      remoteDraft({
        nodes: [
          {
            id: 'start',
            definition: { key: 'core.manual', version: 1 },
            configVersion: 1,
            position: { x: 0, y: 0 },
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [],
        settings: {},
      }),
    );
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
    await page.route(`${root}/tests/prepare`, (route) =>
      route.fulfill({
        json: {
          draftRevision: 1,
          samples: [{ nodeId: 'start', sampleId }],
          effectfulSteps: [],
        },
      }),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    await page.route(`${root}/nodes/start/sample`, async (route) => {
      reads++;
      await held;
      await route.fulfill({
        json: {
          sample: {
            id: sampleId,
            nodeId: 'start',
            binding: 'x',
            state: 'pinned',
            source: { kind: 'json' },
            createdAt: '2026-10-01T00:00:00.000Z',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
          output: { customer: 'old pin' },
          draftRevision: 1,
          limits: { inlineBytes: 262144, depth: 64, members: 10000 },
        },
      });
    });
    await page.goto(editorUrl);
    await chooseTestAction(page, 'Test workflow');
    const dialog = page.getByRole('dialog', {
      name: 'Test workflow',
      exact: true,
    });
    await dialog
      .getByRole('button', { name: 'Use trigger’s pinned sample' })
      .click();
    await expect(
      dialog.getByRole('button', { name: 'Loading pinned sample…' }),
    ).toBeDisabled();
    const input = dialog.getByLabel('Test input (JSON)', { exact: true });
    await input.fill('{"customer":"my edit"}');
    release();
    await expect(
      dialog.getByText(
        'The pinned sample is ready. Your edited input is kept.',
      ),
    ).toBeVisible();
    await expect(input).toHaveValue('{"customer":"my edit"}');
    await dialog.getByRole('button', { name: 'Apply loaded sample' }).click();
    await expect(input).toHaveValue(
      JSON.stringify({ customer: 'old pin' }, null, 2),
    );
    expect(reads).toBe(1);
  });
