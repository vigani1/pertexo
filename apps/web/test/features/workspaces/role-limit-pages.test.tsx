import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { FederationSettingsPage } from '@/features/federation/pages/settings';
import { AuditPage } from '@/features/governance/pages/audit';
import { createApiClient } from '@/lib/api/client';
import { capabilitiesForRole } from '@pertexo/workflow-model';
import { createWorkspaceFixture } from '../../support/fixtures/identity';

const builder = createWorkspaceFixture({
  role: 'builder',
  capabilities: capabilitiesForRole('builder'),
});
const scope = {
  apiClient: createApiClient({
    fetch: vi.fn(),
    readCsrfToken: () => undefined,
  }),
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  workspaceId: builder.id,
};

function inQueries(children: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
  );
}

// The audit log and organization sign-in belong to owners and admins.
it('tells a builder who can read the audit log', () => {
  render(
    inQueries(
      <AuditPage
        scope={scope}
        workspace={builder}
        filters={{}}
        onFilter={vi.fn()}
      />,
    ),
  );
  expect(screen.getByText(/owners and admins can/iu)).toBeVisible();
});

it('tells a builder who can read organization sign-in settings', () => {
  render(
    inQueries(<FederationSettingsPage scope={scope} workspace={builder} />),
  );
  expect(screen.getByText(/owners and admins can/iu)).toBeVisible();
});
