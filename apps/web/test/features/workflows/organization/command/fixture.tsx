import {
  useWorkflowOrganizationCommand,
  type WorkflowOrganizationCommandOptions,
} from '@/features/workflows/hooks/use-workflow-organization-command';
import type { WorkflowOrganizationAttempt } from '@/features/workflows/model/organization/requests';
import { createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { vi } from 'vitest';
import {
  secondWorkflowId,
  userId,
  workflowId,
  workspaceId,
  workspaceWith,
} from '../../list/fixtures';
export const session = {
  listener: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
};

export const workspace = accessibleWorkspaceSchema.parse(
  workspaceWith(['workflow:read', 'workflow:update']),
);

const apiClient = createApiClient({
  fetch: vi.fn(),
  readCsrfToken: () => undefined,
});

export const single = {
  workspaceId,
  idempotencyKey: 'single-key',
  kind: 'place-folder',
  workflowId,
  body: { folderId: null, expectedOrganizationRevision: 7 },
} satisfies WorkflowOrganizationAttempt;

export const receipt = {
  workflowId,
  folderId: null,
  organizationRevision: 2,
  replayed: true,
};

export function bulk(): WorkflowOrganizationAttempt & { kind: 'bulk' } {
  return {
    workspaceId,
    idempotencyKey: 'whole-parent-key',
    kind: 'bulk',
    body: {
      operation: 'move',
      folderId: null,
      items: [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 4 },
        { workflowId, expectedOrganizationRevision: 7 },
      ],
    },
  };
}

export const partial = {
  items: [
    {
      workflowId: secondWorkflowId,
      status: 'updated' as const,
      organizationRevision: 5,
      replayed: false,
    },
    { workflowId, status: 'outcome_unknown' as const },
  ],
};

export const network = () =>
  new ApiError({ kind: 'network', message: 'private-error-body' });

export function deferred() {
  let resolve!: (result: typeof receipt) => void;
  const promise = new Promise<typeof receipt>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

export function setup(
  overrides: Partial<WorkflowOrganizationCommandOptions> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    apiClient,
    userId,
    workspace,
    requiredRole: 'editor' as const,
    ...overrides,
  };
  const hook = renderHook(
    (input: WorkflowOrganizationCommandOptions) =>
      useWorkflowOrganizationCommand(input),
    {
      initialProps: props,
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  return { ...hook, queryClient, props };
}
