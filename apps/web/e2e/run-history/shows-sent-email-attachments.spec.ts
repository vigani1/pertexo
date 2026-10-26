import {
  firstRunId,
  installRoutes,
  run,
  timestamp,
  workflowId,
  workflowVersionId,
  workspaceId,
} from './fixture';
import { expect, test } from '../support/fixtures';

const emailRun = {
  id: '22222222-2222-4222-8222-222222222222',
  nodeId: 'email',
  invocationKey: 'email:0',
  status: 'succeeded',
  currentAttemptNumber: 1,
  startedAt: timestamp,
  completedAt: '2026-09-15T10:00:01.000Z',
  resumeAt: null,
  safeErrorCode: null,
};

for (const theme of ['light', 'dark'] as const)
  for (const width of [1280, 375])
    test(`shows the files a Send email step attached in ${theme} at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript((choice) => {
        localStorage.setItem('pertexo.appearance', choice);
      }, theme);
      await installRoutes(page);
      await page.route(
        `**/v1/workspaces/${workspaceId}/workflows/${workflowId}/versions?**`,
        (route) =>
          route.fulfill({
            json: {
              items: [
                {
                  id: workflowVersionId,
                  workflowId,
                  versionNumber: 1,
                  graph: {
                    nodes: [
                      {
                        id: 'email',
                        label: 'Email the weekly report',
                        definition: {
                          key: 'email.send_notification',
                          version: 1,
                        },
                        configVersion: 1,
                        config: { timeoutMillis: 10_000 },
                        inputMappings: {},
                        connectionRefs: {},
                        position: { x: 0, y: 0 },
                      },
                    ],
                    edges: [],
                    settings: {},
                  },
                  checksum: `wf:sha256:${'a'.repeat(64)}`,
                  publishedAt: timestamp,
                },
              ],
              nextCursor: null,
            },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}`,
        (route) =>
          route.fulfill({
            json: { run: run(firstRunId, 'succeeded'), nodes: [emailRun] },
          }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/input`,
        (route) => route.fulfill({ json: { input: { kind: 'none' } } }),
      );
      await page.route(
        `**/v1/workspaces/${workspaceId}/runs/${firstRunId}/node-runs/*/output`,
        (route) =>
          route.fulfill({
            json: {
              output: {
                kind: 'inline',
                value: {
                  emailId: '49b9a1e5-3f0c-4e68-882d-fbc91c0d4ec2',
                  attachments: [
                    {
                      filename: 'weekly-report-2026-w42.csv',
                      mediaType: 'text/csv; charset=utf-8',
                      byteLength: 48_213,
                    },
                    {
                      filename: 'Terms.pdf',
                      mediaType: 'application/pdf',
                      byteLength: 1_342_177,
                    },
                  ],
                },
              },
            },
          }),
      );
      await page.goto(`/w/${workspaceId}/runs/${firstRunId}`);
      await page
        .getByRole('button', { name: /Email the weekly report/u })
        .first()
        .click();
      const sent = page.getByRole('region', { name: 'Attachments sent' });
      await expect(sent).toContainText('2 files sent · 1.3 MB');
      await expect(sent.getByText('weekly-report-2026-w42')).toBeVisible();
      await expect(sent.getByText('47.1 KB')).toBeVisible();
      await expect(sent.getByText('Terms')).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      if (process.env.PERTEXO_VISUAL_EVIDENCE_DIR !== undefined)
        await page.screenshot({
          path: `${process.env.PERTEXO_VISUAL_EVIDENCE_DIR}/sent-attachments-${theme}-${String(width)}.png`,
          fullPage: true,
        });
    });
