import { randomUUID } from 'node:crypto';
import { expect, type Locator } from '@playwright/test';
import { apiProblemSchema } from '@pertexo/contracts/errors';
import {
  accessibleWorkspacesResponseSchema,
  userProfileResponseSchema,
} from '@pertexo/contracts/schemas/identity-workspace';
import {
  workflowDraftResponseSchema,
  workflowSummaryResponseSchema,
  workflowVersionsResponseSchema,
} from '@pertexo/contracts/schemas/workflow-authoring';
import { workflowRunListResponseSchema } from '@pertexo/contracts/schemas/workflow-runs';
import { uncoveredArea } from '../src/features/workflow-editor/model/canvas-framing';
import { test } from './support/browser-fixture';
import {
  createEditorWorkspace,
  registerEditorUser,
} from './support/ordinary-editor-session';
import {
  addSingleStep,
  createEditorWorkflow,
  publishSingleStep,
  readEditorDraft,
  startSingleStep,
  waitForRun,
} from './support/single-step-authoring';

/** A focusable control must also be usable by pointer in the visible viewport. */
async function expectUnobstructedControl(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        if (
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          bounds.left < 0 ||
          bounds.top < 0 ||
          bounds.right > window.innerWidth ||
          bounds.bottom > window.innerHeight
        )
          return false;
        // Test both the label/icon and inset corners. A covering lens must not
        // make a button appear usable solely because focus can reach it.
        const insetX = Math.min(4, bounds.width / 4);
        const insetY = Math.min(4, bounds.height / 4);
        return [
          [(bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2],
          [bounds.left + insetX, bounds.top + insetY],
          [bounds.right - insetX, bounds.bottom - insetY],
        ].every(([x, y]) => {
          if (x === undefined || y === undefined) return false;
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === element || element.contains(hit));
        });
      }),
    )
    .toBe(true);
}

test('ordinary verified viewer can inspect the real editor at four widths but cannot write', async ({
  browser,
  page,
  request,
}) => {
  const mailOrigin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  if (mailOrigin === undefined) throw new Error('Use the owned API fixture');
  const ownerEmail = await registerEditorUser(
    page,
    request,
    mailOrigin,
    'Readonly qualification owner',
  );
  const workspaceId = await createEditorWorkspace(
    page,
    'Readonly qualification',
  );
  const workflowPath = await createEditorWorkflow(
    page,
    workspaceId,
    'Viewer inspection',
  );
  const workflowId = workflowPath.split('/')[5];
  if (workflowId === undefined) throw new Error('Workflow ID missing');
  const nodeId = await addSingleStep(
    page,
    workflowPath,
    /Set fields/u,
    'Viewer source',
  );
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click();
  await page.getByRole('button', { name: 'Add input', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Inputs', exact: true })
    .locator('ol > li')
    .last();
  await row.getByLabel('Field', { exact: true }).fill('proof');
  await row.getByRole('button', { name: 'Run input', exact: true }).click();
  await row.getByLabel('Run input path', { exact: true }).fill('$.proof');
  await page.keyboard.press('Tab');
  await expect
    .poll(
      async () =>
        (await readEditorDraft(page, workflowPath)).graph.nodes[0]
          ?.inputMappings,
    )
    .toEqual({ proof: { kind: 'run_input', path: '$.proof' } });
  const version = await publishSingleStep(page, workflowPath);
  const runId = await startSingleStep(page, { proof: 'readonly-baseline' });
  await waitForRun(page, workspaceId, runId, 'succeeded');
  const ownerDraftResponse = await page.request.get(`${workflowPath}/draft`);
  expect(ownerDraftResponse.status()).toBe(200);
  const ownerDraft = workflowDraftResponseSchema.parse(
    await ownerDraftResponse.json(),
  );
  const etag = ownerDraftResponse.headers().etag;
  expect(etag).toMatch(/^"[^"\r\n]+"$/u);
  const ownerVersionsResponse = await page.request.get(
    `${workflowPath}/versions`,
  );
  expect(ownerVersionsResponse.status()).toBe(200);
  const ownerVersions = workflowVersionsResponseSchema.parse(
    await ownerVersionsResponse.json(),
  );

  const context = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const viewer = await context.newPage();
    const viewerEmail = await registerEditorUser(
      viewer,
      request,
      mailOrigin,
      'Readonly qualification viewer',
    );
    const setup = await request.post(`${mailOrigin}/readonly-setup`, {
      data: { workspaceId, workflowId, ownerEmail, viewerEmail },
    });
    expect(setup.status()).toBe(200);
    const identityResponse = await viewer.request.get('/v1/users/me');
    expect(identityResponse.status()).toBe(200);
    const identity = userProfileResponseSchema.parse(
      await identityResponse.json(),
    );
    expect(identity.email).toBe(viewerEmail);
    expect(await setup.json()).toEqual({
      workspaceId,
      workflowId,
      viewerId: identity.id,
    });
    const discoveryResponse = await viewer.request.get('/v1/workspaces');
    expect(discoveryResponse.status()).toBe(200);
    const accessible = accessibleWorkspacesResponseSchema
      .parse(await discoveryResponse.json())
      .items.find((item) => item.id === workspaceId);
    expect(accessible?.role).toBe('viewer');
    expect(accessible?.capabilities).toContain('workflow:read');
    for (const capability of [
      'workflow:update',
      'workflow:publish',
      'run:start',
      'run:replay',
      'run:cancel',
      'workspace:manage',
    ])
      expect(accessible?.capabilities).not.toContain(capability);
    const summaryResponse = await viewer.request.get(workflowPath);
    expect(summaryResponse.status()).toBe(200);
    expect(
      workflowSummaryResponseSchema.parse(await summaryResponse.json()).workflow
        .publishedVersionId,
    ).toBe(version.id);
    const viewerDraftResponse = await viewer.request.get(
      `${workflowPath}/draft`,
    );
    expect(viewerDraftResponse.status()).toBe(200);
    expect(viewerDraftResponse.headers().etag).toBe(etag);
    expect(
      workflowDraftResponseSchema.parse(await viewerDraftResponse.json()),
    ).toEqual(ownerDraft);
    const versionsResponse = await viewer.request.get(
      `${workflowPath}/versions`,
    );
    expect(versionsResponse.status()).toBe(200);
    expect(
      workflowVersionsResponseSchema.parse(await versionsResponse.json()),
    ).toEqual(ownerVersions);
    const runsResponse = await viewer.request.get(
      `/v1/workspaces/${workspaceId}/runs?workflowId=${workflowId}`,
    );
    expect(runsResponse.status()).toBe(200);
    expect(
      workflowRunListResponseSchema
        .parse(await runsResponse.json())
        .items.map((run) => run.id),
    ).toEqual([runId]);

    // UI zero-write observation is independent of intentional API denial probes.
    const uiWrites: string[] = [];
    viewer.on('request', (outgoing) => {
      if (
        new URL(outgoing.url()).pathname.startsWith(workflowPath) &&
        !['GET', 'HEAD'].includes(outgoing.method())
      )
        uiWrites.push(
          `${outgoing.method()} ${new URL(outgoing.url()).pathname}`,
        );
    });
    await viewer.emulateMedia({ reducedMotion: 'reduce' });
    for (const width of [390, 1024, 1280, 1440]) {
      await viewer.setViewportSize({ width, height: 900 });
      await viewer.goto(`/w/${workspaceId}/workflows/${workflowId}`);
      await expect(viewer.getByTestId(`rf__node-${nodeId}`)).toBeVisible();
      await expect(
        viewer.getByRole('complementary', { name: 'Add a step' }),
      ).toHaveCount(0);
      await expect(
        viewer.getByRole('button', { name: /^Publish/u }),
      ).toHaveCount(0);
      await expect(
        viewer.getByRole('button', { name: 'Run', exact: true }),
      ).toHaveCount(0);
      const node = viewer.getByTestId(`rf__node-${nodeId}`);
      await node.focus();
      await expect(node).toBeFocused();
      await viewer.keyboard.press('Enter');
      if (width < 1024)
        await viewer
          .getByRole('navigation', { name: 'Editor panels' })
          .getByRole('button', { name: 'Step', exact: true })
          .click();
      if (width < 1024) {
        const panels = viewer.getByRole('navigation', {
          name: 'Editor panels',
        });
        for (const name of ['Canvas', 'Step'])
          await expectUnobstructedControl(
            panels.getByRole('button', { name, exact: true }),
          );
      }
      const label = viewer.getByLabel('Label', { exact: true });
      await expect(label).toBeVisible();
      await expect(label).toBeDisabled();
      const labelBounds = await label.boundingBox();
      expect(labelBounds?.width).toBeGreaterThan(150);
      expect(labelBounds?.x).toBeGreaterThanOrEqual(0);
      expect(
        (labelBounds?.x ?? 0) + (labelBounds?.width ?? 0),
      ).toBeLessThanOrEqual(width);
      if (width >= 640) {
        await expect(
          viewer.getByRole('button', { name: 'Undo', exact: true }),
        ).toBeDisabled();
        await expect(
          viewer.getByRole('button', { name: 'Redo', exact: true }),
        ).toBeDisabled();
      } else {
        await viewer
          .getByRole('button', { name: 'More editor actions', exact: true })
          .click();
        await expect(
          viewer.getByRole('menuitem', { name: /^Undo/u }),
        ).toHaveAttribute('aria-disabled', 'true');
        await expect(
          viewer.getByRole('menuitem', { name: /^Redo/u }),
        ).toHaveAttribute('aria-disabled', 'true');
        await viewer.keyboard.press('Escape');
      }
      const inputsTab = viewer.getByRole('tab', {
        name: 'Inputs',
        exact: true,
      });
      await inputsTab.focus();
      await viewer.keyboard.press('Enter');
      const inputs = viewer.getByRole('region', {
        name: 'Inputs',
        exact: true,
      });
      await expect(
        inputs.getByRole('button', { name: 'Add input', exact: true }),
      ).toHaveCount(0);
      await inputs.getByRole('button', { name: /^proof from/u }).click();
      await expect(inputs.getByLabel('Field', { exact: true })).toBeDisabled();
      await expect(
        inputs.getByLabel('Run input path', { exact: true }),
      ).toBeDisabled();
      await viewer.screenshot({
        path: `/tmp/pertexo-live-readonly-${String(width)}-inspector.png`,
      });
      const canvas = viewer.getByRole('region', {
        name: 'Workflow canvas',
        exact: true,
      });
      if (width >= 1024) {
        const visible = await canvas.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return {
            canvas: {
              left: box.left,
              top: box.top,
              right: box.right,
              bottom: box.bottom,
            },
            covers: [...document.querySelectorAll('[data-canvas-cover]')].map(
              (cover) => {
                const bounds = cover.getBoundingClientRect();
                return {
                  left: bounds.left,
                  top: bounds.top,
                  right: bounds.right,
                  bottom: bounds.bottom,
                };
              },
            ),
          };
        });
        expect(
          uncoveredArea(visible.canvas, visible.covers).width,
        ).toBeGreaterThanOrEqual(500);
      }
      await viewer
        .getByRole('button', { name: 'Close step panel', exact: true })
        .click();
      if (width < 1024) {
        const panels = viewer.getByRole('navigation', {
          name: 'Editor panels',
        });
        for (const name of ['Canvas', 'Step']) {
          const button = panels.getByRole('button', { name, exact: true });
          await expectUnobstructedControl(button);
          await button.focus();
          await expect(button).toBeFocused();
        }
      }
      const available = await canvas.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          canvas: {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          },
          covers: [...document.querySelectorAll('[data-canvas-cover]')].map(
            (cover) => {
              const bounds = cover.getBoundingClientRect();
              return {
                left: bounds.left,
                top: bounds.top,
                right: bounds.right,
                bottom: bounds.bottom,
              };
            },
          ),
        };
      });
      const area = uncoveredArea(available.canvas, available.covers);
      expect(area.width).toBeGreaterThanOrEqual(300);
      expect(area.height).toBeGreaterThanOrEqual(300);
      for (const name of ['Zoom in', 'Zoom out', 'Fit workflow to screen']) {
        const button = viewer.getByRole('button', { name, exact: true });
        await expectUnobstructedControl(button);
        await button.focus();
        await expect(button).toBeFocused();
        await viewer.keyboard.press('Enter');
      }
      await expect
        .poll(async () => {
          const box = await node.boundingBox();
          return (
            box !== null &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= width &&
            box.y + box.height <= 900
          );
        })
        .toBe(true);
      await viewer.screenshot({
        path: `/tmp/pertexo-live-readonly-${String(width)}-canvas.png`,
      });
    }
    expect(uiWrites).toEqual([]);

    const csrf = (await context.cookies()).find(
      (cookie) => cookie.name === 'pertexo_csrf',
    )?.value;
    if (csrf === undefined || etag === undefined)
      throw new Error('Ordinary session CSRF/ETag missing');
    const headers = {
      'x-csrf-token': decodeURIComponent(csrf),
      'Idempotency-Key': randomUUID(),
      'If-Match': etag,
    };
    for (const [method, path, data] of [
      ['PUT', `${workflowPath}/draft`, { graph: ownerDraft.graph }],
      ['POST', `${workflowPath}/publish`, {}],
      [
        'POST',
        `${workflowPath}/runs`,
        { input: { proof: 'must-not-execute' } },
      ],
    ] as const) {
      const denied = await viewer.request.fetch(path, {
        method,
        headers,
        data,
      });
      expect(denied.status()).toBe(404);
      expect(apiProblemSchema.parse(await denied.json()).code).toBe(
        'resource.not_found',
      );
    }
    const ownerAfter = await page.request.get(`${workflowPath}/draft`);
    expect(ownerAfter.status()).toBe(200);
    expect(ownerAfter.headers().etag).toBe(etag);
    expect(workflowDraftResponseSchema.parse(await ownerAfter.json())).toEqual(
      ownerDraft,
    );
    await viewer.goto(`/w/${workspaceId}/workflows`);
    await expect(viewer).toHaveURL(`/w/${workspaceId}/workflows`);
    await expect(
      viewer.getByRole('button', { name: 'New workflow', exact: true }),
    ).toHaveCount(0);
    expect(uiWrites).toEqual([]);
    const submitted = await request.post(`${mailOrigin}/evidence/readonly`, {
      data: { workspaceId, workflowId, viewerId: identity.id },
    });
    expect(submitted.status()).toBe(204);
  } finally {
    await context.close();
  }
});
