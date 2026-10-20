import { chooseTestAction, expect, test } from '../../support/fixtures';
import {
  addCsrfCookie,
  editorUrl,
  installEditorRoutes,
  remoteDraft,
  workflowId,
  workspaceId,
  user,
} from '../support';
const suiteId = '22222222-2222-4222-8222-222222222222',
  caseId = '11111111-1111-4111-8111-111111111111';
for (const width of [1280, 375])
  test(`suite effects consent and private comparison reports at ${String(width)}px`, async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width, height: 768 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addCsrfCookie(context);
    await page.route('**/v1/**', (route) => route.fulfill({ status: 404 }));
    await installEditorRoutes(page, remoteDraft());
    const current = {
      signature: 'a'.repeat(64),
      draftRevision: 1,
      variableSetRevision: null,
      samples: [],
      cases: [{ id: caseId, revision: 1, name: 'Order' }],
    };
    const summary = {
      suiteId,
      startedBy: user.id,
      draftRevision: 1,
      signature: current.signature,
      status: 'failed',
      stopReason: null,
      createdAt: '2026-10-17T10:00:00.000Z',
      completedAt: '2026-10-17T10:00:02.000Z',
      expiresAt: '2026-10-24T10:00:00.000Z',
      total: 1,
      passed: 0,
      failed: 1,
      errors: 0,
      skipped: 0,
    };
    const root = `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/test-suites`;
    let accepted = false;
    const writes: { body: unknown; key: string | undefined }[] = [];
    await page.route(root, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: { current, items: accepted ? [summary] : [] },
        });
        return;
      }
      writes.push({
        body: route.request().postDataJSON() as unknown,
        key: route.request().headers()['idempotency-key'],
      });
      accepted = true;
      await route.fulfill({ status: 202, json: { suiteId } });
    });
    await page.route(`${root}/prepare`, (route) =>
      route.fulfill({
        json: {
          ...current,
          effectfulSteps: [{ nodeId: 'http', label: 'Send order' }],
        },
      }),
    );
    await page.route(`${root}/${suiteId}`, (route) =>
      route.fulfill({
        json: {
          ...summary,
          cases: [
            {
              ordinal: 0,
              caseId,
              caseRevision: 1,
              name: 'Order',
              status: 'failed',
              runId: null,
            },
          ],
        },
      }),
    );
    await page.route(`${root}/${suiteId}/cases/0`, (route) =>
      route.fulfill({
        json: {
          report: {
            expectedOutcome: 'succeeds',
            actualOutcome: 'succeeded',
            outcomeMatched: true,
            assertions: [
              {
                assertion: {
                  source: { kind: 'step', nodeId: 'set' },
                  path: '$.amount',
                  operator: 'equals',
                  expected: 7,
                },
                actual: { state: 'value', matched: false, value: 8 },
              },
            ],
          },
        },
      }),
    );
    await page.goto(editorUrl);
    await chooseTestAction(page, 'Run all tests');
    const dialog = page.getByRole('dialog', {
      name: 'Run all tests',
      exact: true,
    });
    await expect(dialog).toContainText('Send order');
    await expect(
      dialog.getByRole('button', { name: 'Start suite', exact: true }),
    ).toBeDisabled();
    await dialog
      .getByRole('switch', {
        name: 'I understand every case runs these steps for real',
      })
      .click();
    await dialog
      .getByRole('button', { name: 'Start suite', exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBeTruthy();
    expect(writes[0]?.body).toEqual({
      expectedRevision: 1,
      expectedSamples: [],
      expectedEffectfulSteps: ['http'],
      expectedCases: [{ id: caseId, revision: 1 }],
      expectedVariableSetRevision: null,
      signature: current.signature,
      acknowledgeSideEffects: true,
    });
    // A started suite opens the tests bar on its history.
    const history = page.getByRole('region', {
      name: 'Test suites',
      exact: true,
    });
    await expect(history).toContainText('Suite · failed');
    await history
      .getByRole('button', { name: 'Report Order', exact: true })
      .click();
    await expect(history.locator('pre').first()).toHaveText('7');
    await expect(history.locator('pre').last()).toHaveText('8');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
