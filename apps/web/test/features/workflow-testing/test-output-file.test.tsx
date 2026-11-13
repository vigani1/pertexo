import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { TestOutputValue } from '@/features/workflow-testing/components/workflow-tests/results';
import type { WorkflowTests } from '@/features/workflow-testing/hooks/use-workflow-tests';
import { createApiClient } from '@/lib/api/client';

const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const artifactId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function renderOutput(output: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = input instanceof Request ? input.url : String(input);
    return Promise.resolve(
      url.includes('/output')
        ? Response.json({ output })
        : new Response('not here', { status: 404 }),
    );
  });
  // A test output reads only the test's scope.
  const tests = {
    scope: {
      apiClient: createApiClient({ fetch, readCsrfToken: () => undefined }),
      userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      workspaceId,
      workflowId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    },
  } as WorkflowTests;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TestOutputValue
        tests={tests}
        runId="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        nodeRunId="ffffffff-ffff-4fff-8fff-ffffffffffff"
        status="succeeded"
      />
    </QueryClientProvider>,
  );
}

it('offers a test step’s file output for download', async () => {
  renderOutput({ kind: 'artifact', artifactId });
  expect(
    await screen.findByRole('button', { name: /Download/u }),
  ).toBeVisible();
  expect(screen.queryByText(/is no longer available/u)).toBeNull();
});

it('says why an expired or empty test output shows nothing', async () => {
  renderOutput({ kind: 'expired' });
  expect(
    await screen.findByText(/No longer kept\. Pertexo keeps test data for/u),
  ).toBeVisible();
});
