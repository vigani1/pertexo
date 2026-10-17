import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/button';
import { useTestSuites } from '@/features/workflow-publish/hooks/use-test-suites';
import { TestSuiteDialog } from '@/features/workflow-publish/components/test-suites/dialog';
import { SuitePublishNotice } from '@/features/workflow-publish/components/test-suites/publish-notice';
import { TestCaseReport } from '@/features/workflow-publish/components/test-suites/report';
import { createApiClient } from '@/lib/api/client';
import { renderInRouter } from '../../support/render-in-router';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  caseId = '11111111-1111-4111-8111-111111111111',
  suiteId = '22222222-2222-4222-8222-222222222222',
  userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId,
  workspaceId,
  workflowId,
};
const root = `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft/test-suites`;
const current = {
  signature: 'a'.repeat(64),
  draftRevision: 3,
  variableSetRevision: 7,
  samples: [],
  cases: [{ id: caseId, revision: 2, name: 'Small order' }],
};
const summary = {
  suiteId,
  startedBy: userId,
  draftRevision: 3,
  signature: current.signature,
  status: 'passed',
  stopReason: null,
  createdAt: '2026-10-17T10:00:00.000Z',
  completedAt: '2026-10-17T10:00:02.000Z',
  expiresAt: '2026-10-24T10:00:00.000Z',
  total: 1,
  passed: 1,
  failed: 0,
  errors: 0,
  skipped: 0,
};
function Harness({
  ensureSaved,
  verifyIdentity,
}: Readonly<{
  ensureSaved: () => Promise<{ revision: number }>;
  verifyIdentity: () => Promise<void>;
}>) {
  const suites = useTestSuites({
    scope,
    enabled: true,
    ensureSaved,
    verifyIdentity,
  });
  return (
    <>
      <Button onClick={() => void suites.prepare()}>Run all tests</Button>
      <TestSuiteDialog key={String(suites.open)} suites={suites} />
    </>
  );
}
describe('draft test suites', () => {
  it('saves first, lists effectful steps once and preserves the exact uncertain suite command', async () => {
    let accepted = false;
    const writes: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      http.get(root, () =>
        HttpResponse.json({ current, items: accepted ? [summary] : [] }),
      ),
      http.get(`${root}/prepare`, () =>
        HttpResponse.json({
          ...current,
          effectfulSteps: [{ nodeId: 'http', label: 'Send order' }],
        }),
      ),
      http.post(root, async ({ request }) => {
        writes.push({
          key: request.headers.get('idempotency-key'),
          body: await request.json(),
        });
        if (writes.length === 1) return HttpResponse.error();
        accepted = true;
        return HttpResponse.json({ suiteId }, { status: 202 });
      }),
      http.get(`${root}/${suiteId}`, () =>
        HttpResponse.json({
          ...summary,
          cases: [
            {
              ordinal: 0,
              caseId,
              caseRevision: 2,
              name: 'Small order',
              status: 'passed',
              runId: null,
            },
          ],
        }),
      ),
    );
    const ensureSaved = vi.fn().mockResolvedValue({ revision: 3 }),
      verifyIdentity = vi.fn().mockResolvedValue(undefined);
    renderInRouter(
      <Harness ensureSaved={ensureSaved} verifyIdentity={verifyIdentity} />,
    );
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Run all tests' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Run all tests',
    });
    await within(dialog).findByText('Small order');
    expect(ensureSaved).toHaveBeenCalledOnce();
    expect(
      within(dialog).getByRole('button', { name: 'Start suite' }),
    ).toBeDisabled();
    expect(within(dialog).getByText('Send order')).toBeVisible();
    await event.click(
      within(dialog).getByRole('switch', {
        name: 'I understand every case runs these steps for real',
      }),
    );
    await event.click(
      within(dialog).getByRole('button', { name: 'Start suite' }),
    );
    await event.click(
      await within(dialog).findByRole('button', {
        name: 'Retry same suite request',
      }),
    );
    await waitFor(() => {
      expect(writes).toHaveLength(2);
    });
    expect(writes[0]).toEqual(writes[1]);
    expect(writes[0]?.key).toBeTruthy();
    expect(writes[0]?.body).toEqual({
      expectedRevision: 3,
      expectedSamples: [],
      expectedEffectfulSteps: ['http'],
      expectedCases: [{ id: caseId, revision: 2 }],
      expectedVariableSetRevision: 7,
      signature: current.signature,
      acknowledgeSideEffects: true,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(verifyIdentity).toHaveBeenCalledTimes(3);
  });
  it('shows failed and outdated suite evidence without a publication command', async () => {
    mockServer.use(
      http.get(root, () =>
        HttpResponse.json({
          current: { ...current, signature: 'b'.repeat(64) },
          items: [{ ...summary, status: 'failed', passed: 0, failed: 1 }],
        }),
      ),
    );
    renderInRouter(
      <SuitePublishNotice
        scope={scope}
        enabled
        savedDraftCurrent
        capabilities={['workflow:update', 'run:read', 'run:start']}
      />,
    );
    await screen.findByText(/Latest suite: failed/u);
    expect(screen.getByText(/Out of date/u)).toBeVisible();
    expect(screen.getByText(/publishing is still available/u)).toBeVisible();
  });
  it('shows bounded actuals and missing values without injecting output markup', async () => {
    mockServer.use(
      http.get(`${root}/${suiteId}/cases/0`, () =>
        HttpResponse.json({
          report: {
            expectedOutcome: 'succeeds',
            actualOutcome: 'succeeded',
            outcomeMatched: true,
            assertions: [
              {
                assertion: {
                  source: { kind: 'final' },
                  path: '$.label',
                  operator: 'contains',
                  expected: 'thread',
                },
                actual: {
                  state: 'value',
                  matched: false,
                  preview: '<script>test</script>',
                  bytes: 9000,
                  truncated: true,
                },
              },
              {
                assertion: {
                  source: { kind: 'step', nodeId: 'set' },
                  path: '$.missing',
                  operator: 'equals',
                  expected: null,
                },
                actual: { state: 'missing', matched: false },
              },
            ],
          },
        }),
      ),
    );
    const { container } = renderInRouter(
      <TestCaseReport scope={scope} suiteId={suiteId} ordinal={0} />,
    );
    expect(await screen.findByText('<script>test</script>')).toBeVisible();
    expect(screen.getByText(/9000 bytes, preview truncated/u)).toBeVisible();
    expect(
      screen.getByText('No value is available at this path.'),
    ).toBeVisible();
    expect(container.querySelector('script')).toBeNull();
  });
});
