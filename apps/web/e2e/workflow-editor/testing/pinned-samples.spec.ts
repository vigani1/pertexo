import {
  stepSampleDeleteRequestSchema,
  stepSampleWriteRequestSchema,
  type StepSampleMetadata,
} from '@pertexo/contracts';
import {
  parseWorkflowGraphDraft,
  stepSampleIdentity,
} from '@pertexo/workflow-model';
import { expect, test } from '../../support/fixtures';
import { editorNode } from '../graph';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
} from '../support';
const sampleId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const previewId = '33333333-3333-4333-8333-333333333333';
const limits = { inlineBytes: 262144, depth: 64, members: 10000 };
for (const width of [375, 1280]) {
  test(`pins and reviews sample data with an exact retry at ${String(width)}px`, async ({
    page,
    context,
  }, info) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const node = editorNode('sample', 'Sample source', 'real', 80);
    const remote = remoteDraft({ nodes: [node], edges: [], settings: {} });
    let sample: StepSampleMetadata | null = null;
    let output: unknown = null;
    const writes: { body: unknown; key: string }[] = [];
    await addCsrfCookie(context);
    await installEditorRoutes(page, remote);
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
    const metadata = () => {
      if (sample === null) return null;
      const current = parseWorkflowGraphDraft(remote.graph).nodes[0];
      return {
        ...sample,
        state:
          current !== undefined &&
          sample.binding === stepSampleIdentity(current)
            ? 'pinned'
            : 'stale',
      };
    };
    await page.route(`${root}/samples`, (route) =>
      route.fulfill({
        json: {
          items: sample === null ? [] : [metadata()],
          draftRevision: remote.revision,
          limits,
        },
      }),
    );
    await page.route(`${root}/nodes/sample/sample`, async (route) => {
      if (route.request().method() === 'PUT') {
        const body = stepSampleWriteRequestSchema.parse(
          route.request().postDataJSON(),
        );
        writes.push({
          body,
          key: route.request().headers()['idempotency-key'] ?? '',
        });
        if (writes.length === 2) {
          expect(writes[1]).toEqual(writes[0]);
          await route.fulfill({
            json: { sampleId, removed: false, replayed: true },
          });
          return;
        }
        const current = parseWorkflowGraphDraft(remote.graph).nodes[0];
        if (current === undefined) throw new Error('Step missing');
        output = body.source.kind === 'json' ? body.source.value : output;
        sample = {
          id: body.source.kind === 'confirm' ? secondId : sampleId,
          nodeId: node.id,
          binding: stepSampleIdentity(current),
          state: 'pinned',
          source: { kind: 'json' },
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 2592000000).toISOString(),
        };
        if (writes.length === 1) {
          await route.abort('failed');
          return;
        }
        await route.fulfill({
          json: { sampleId: sample.id, removed: false, replayed: false },
        });
      } else if (route.request().method() === 'DELETE') {
        const body = stepSampleDeleteRequestSchema.parse(
          route.request().postDataJSON(),
        );
        expect(body.expectedSampleId).toBe(secondId);
        sample = null;
        output = null;
        await route.fulfill({
          json: { sampleId: secondId, removed: true, replayed: false },
        });
      } else
        await route.fulfill({
          json: {
            sample: metadata(),
            output,
            draftRevision: remote.revision,
            limits,
          },
        });
    });
    await page.route(`${root}/nodes/sample/test`, async (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        expectedSampleId: sampleId,
      });
      await route.fulfill({
        status: 202,
        json: {
          mode: 'test_execute',
          replayed: false,
          preview: {
            id: previewId,
            workspaceId,
            workflowId,
            draftRevision: remote.revision,
            nodeId: node.id,
            pinnedSampleId: sampleId,
            status: 'succeeded',
            disclosure: {
              sideEffectClass: 'safe',
              mayContactProvider: false,
              mayCauseExternalSideEffect: false,
              dryRun: 'not_supported',
            },
            output: { kind: 'inline', value: output },
            safeErrorCode: null,
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 604800000).toISOString(),
          },
        },
      });
    });
    await page.goto(editorUrl);
    await page.getByTestId('rf__node-sample').focus();
    await page.keyboard.press('Enter');
    if (width < 1024)
      await page
        .getByRole('navigation', { name: 'Editor panels' })
        .getByRole('button', { name: 'Step', exact: true })
        .click();
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await page
      .getByRole('button', { name: 'Paste JSON…', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Pin sample output' });
    await dialog
      .getByLabel('Output (JSON)', { exact: true })
      .fill('{"amount":1240}');
    await dialog
      .getByRole('button', { name: 'Pin output', exact: true })
      .click();
    await expect(
      dialog.getByRole('button', { name: 'Retry the same pin', exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByLabel('Output (JSON)', { exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('button', { name: 'Retry the same pin', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(2);
    await page
      .getByRole('button', { name: 'Test with pinned output', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Test result' }),
    ).toContainText('Pinned');
    await expect(
      page.getByRole('group', { name: 'Test output' }),
    ).toContainText('1240');
    await expect(page.getByTestId('rf__node-sample')).toContainText('Pinned');
    await page.screenshot({
      path: info.outputPath(`pinned-${String(width)}.png`),
    });
    await page.getByRole('tab', { name: 'Setup', exact: true }).click();
    await page.getByLabel('Value', { exact: true }).fill('changed');
    await page.keyboard.press('Tab');
    await page.getByRole('tab', { name: 'Test', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Pinned sample' }),
    ).toContainText('Pin needs review');
    await expect(
      page.getByRole('button', { name: /^Run (?:another )?test$/u }),
    ).toBeDisabled();
    await page
      .getByRole('button', { name: 'Confirm for this setup', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: 'Test with pinned output',
        exact: true,
      }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Remove pin', exact: true }).click();
    await expect(
      page.getByRole('button', { name: /^Run (?:another )?test$/u }),
    ).toBeDisabled();
    await expect(page.getByTestId('rf__node-sample')).not.toContainText(
      'Pinned',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
