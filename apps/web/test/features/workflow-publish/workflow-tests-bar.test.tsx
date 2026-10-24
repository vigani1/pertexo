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

function Harness() {
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
        canCancel
      />
    </>
  );
}

function mount() {
  mockServer.use(
    http.get(`${draft}/tests`, () => HttpResponse.json({ items: [] })),
    http.get(`${draft}/test-suites`, () => HttpResponse.json({ items: [] })),
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
  renderInRouter(<Harness />);
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
});
