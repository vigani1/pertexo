import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RunDataValue } from '@/features/workflow-runs/components/run-detail/data/value';
import { createApiClient } from '@/lib/api/client';
import { createWorkspaceFixture } from '../../support/fixtures/identity';

it('says run data, not run input, when a step’s output has expired', () => {
  render(
    <RunDataValue
      data={{ kind: 'expired' }}
      title="Data out of Set fields"
      emptyText="This step didn’t return anything."
      scope={{
        apiClient: createApiClient({
          fetch: vi.fn<typeof globalThis.fetch>(),
          readCsrfToken: () => undefined,
        }),
        userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        workspace: createWorkspaceFixture({}),
        runId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      }}
    />,
  );
  expect(
    screen.getByText(
      /^No longer kept\. Pertexo keeps run data for \d+ days\.$/u,
    ),
  ).toBeVisible();
  expect(screen.queryByText(/run’s input/u)).toBeNull();
});
