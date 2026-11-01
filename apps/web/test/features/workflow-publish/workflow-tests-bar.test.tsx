import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { useWorkflowTests } from '@/features/workflow-publish/hooks/use-workflow-tests';
import {
  WorkflowTestButton,
  WorkflowTestHistory,
} from '@/features/workflow-publish/tests.public';
import { createApiClient } from '@/lib/api/client';
import { fixtureRun } from '../../support/fixtures/run';
import { renderInRouter } from '../../support/render-in-router';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  workflowId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const draft = `http://pertexo.test/v1/workspaces/${workspaceId}/workflows/${workflowId}/draft`;
const scope = {
  apiClient: createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  }),
  userId,
  workspaceId,
  workflowId,
};

function Harness({ canCancelAny = true }: { canCancelAny?: boolean }) {
  const ensureSaved = vi.fn().mockResolvedValue({ revision: 3 });
  const tests = useWorkflowTests({
    scope,
    enabled: true,
    ensureSaved,
    verifyIdentity: () => Promise.resolve(),
  });
  return (
    <>
      <WorkflowTestButton tests={tests} />
      <WorkflowTestHistory
        tests={tests}
        ensureSaved={ensureSaved}
        currentRevision={3}
        canCancelAny={canCancelAny}
      />
    </>
  );
}

function mount({
  canCancelAny = true,
  suites = [],
}: {
  canCancelAny?: boolean;
  suites?: readonly unknown[];
} = {}) {
  mockServer.use(
    http.get(`${draft}/tests`, () => HttpResponse.json({ items: [] })),
    http.get(`${draft}/test-suites`, () =>
      HttpResponse.json({
        current: {
          signature: 'a'.repeat(64),
          draftRevision: 3,
          variableSetRevision: 7,
          samples: [],
          cases: [],
        },
        items: suites,
      }),
    ),
    http.get(`${draft}/test-suites/prepare`, () =>
      HttpResponse.json({
        signature: 'a'.repeat(64),
        draftRevision: 3,
        variableSetRevision: 7,
        samples: [],
        cases: [],
      }),
    ),
  );
  renderInRouter(<Harness canCancelAny={canCancelAny} />);
  return userEvent.setup();
}

async function openTestMenu(event: ReturnType<typeof userEvent.setup>) {
  await event.click(
    await screen.findByRole('button', { name: 'More test actions' }),
  );
  return screen.findByRole('menu');
}

describe('workflow tests bar', () => {
  it('stays away until asked for, opens on Test history and closes again', async () => {
    const event = mount();
    expect(
      await screen.findByRole('button', { name: 'Test workflow' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('region', { name: 'Workflow tests' }),
    ).not.toBeInTheDocument();

    const menu = await openTestMenu(event);
    await event.click(
      within(menu).getByRole('menuitem', { name: 'Test history' }),
    );
    const bar = await screen.findByRole('region', { name: 'Workflow tests' });
    expect(
      await within(bar).findByText('No workflow tests yet.'),
    ).toBeVisible();

    await event.click(within(bar).getByRole('button', { name: 'Close tests' }));
    expect(
      screen.queryByRole('region', { name: 'Workflow tests' }),
    ).not.toBeInTheDocument();
  });

  it('runs all tests from the Test workflow menu', async () => {
    const event = mount();
    const menu = await openTestMenu(event);
    await event.click(
      within(menu).getByRole('menuitem', { name: 'Run all tests' }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Run all tests' }),
    ).toBeVisible();
  });

  describe('who sees the way to stop a run', () => {
    const someoneElse = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      suiteId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const suite = (startedBy: string) => ({
      suiteId,
      startedBy,
      draftRevision: 3,
      signature: 'a'.repeat(64),
      status: 'running',
      stopReason: null,
      createdAt: '2026-11-02T10:00:00.000Z',
      completedAt: null,
      expiresAt: '2026-11-03T10:00:00.000Z',
      total: 1,
      passed: 0,
      failed: 0,
      errors: 0,
      skipped: 0,
    });
    async function openHistory(startedBy: string, canCancelAny: boolean) {
      const event = mount({ canCancelAny, suites: [suite(startedBy)] });
      mockServer.use(
        http.get(`${draft}/test-suites/${suiteId}`, () =>
          HttpResponse.json({ ...suite(startedBy), cases: [] }),
        ),
      );
      const menu = await openTestMenu(event);
      await event.click(
        within(menu).getByRole('menuitem', { name: 'Test history' }),
      );
      await screen.findByText('Suite · running');
    }

    it('offers a builder the stop on a suite they started', async () => {
      await openHistory(userId, false);
      expect(
        screen.getByRole('button', { name: 'Cancel suite' }),
      ).toBeVisible();
    });

    it("doesn't offer a builder the stop on someone else's suite", async () => {
      await openHistory(someoneElse, false);
      expect(
        screen.queryByRole('button', { name: 'Cancel suite' }),
      ).not.toBeInTheDocument();
    });

    it("offers someone who can cancel any run the stop on someone else's suite", async () => {
      await openHistory(someoneElse, true);
      expect(
        screen.getByRole('button', { name: 'Cancel suite' }),
      ).toBeVisible();
    });

    const runId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    async function openRunningTest(startedBy: string, canCancelAny: boolean) {
      const test = {
        runId,
        startedBy,
        draftRevision: 3,
        status: 'running',
        createdAt: '2026-11-02T10:00:00.000Z',
        expiresAt: '2026-11-03T10:00:00.000Z',
      };
      const run = `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${runId}`;
      mount({ canCancelAny });
      mockServer.use(
        http.get(`${draft}/tests`, () => HttpResponse.json({ items: [test] })),
        http.get(`${draft}/tests/${runId}`, () =>
          HttpResponse.json({
            ...test,
            graph: { settings: {}, nodes: [], edges: [] },
            dispositions: {},
          }),
        ),
        http.get(run, () =>
          HttpResponse.json({
            run: fixtureRun(runId, 'running', { workspaceId, workflowId }),
            nodes: [],
          }),
        ),
        http.get(
          `${run}/events`,
          () =>
            new HttpResponse('', {
              headers: { 'content-type': 'text/event-stream' },
            }),
        ),
      );
      await screen.findByText('Test · Running');
    }

    it('offers a builder the stop on a test they started', async () => {
      await openRunningTest(userId, false);
      expect(
        await screen.findByRole('button', { name: 'Cancel test' }),
      ).toBeVisible();
    });

    it("doesn't offer a builder the stop on someone else's test", async () => {
      await openRunningTest(someoneElse, false);
      await screen.findByText(/Draft 3/u);
      expect(
        screen.queryByRole('button', { name: 'Cancel test' }),
      ).not.toBeInTheDocument();
    });
  });
});
