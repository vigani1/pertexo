import {
  useWorkflowOrganizationCommand,
  type WorkflowOrganizationCommandOptions,
} from '@/features/workflows/hooks/use-workflow-organization-command';
import type { WorkflowOrganizationAttempt } from '@/features/workflows/model/organization/requests';
import { createApiClient } from '@/lib/api/client';
import {
  accessibleWorkspaceSchema,
  type AccessibleWorkspace,
} from '@pertexo/contracts';
import { capabilitiesForRole } from '@pertexo/workflow-model';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { mockServer } from '../../../../support/mock-server';
import { testFetch } from '../../../../support/render-app';
import {
  api,
  secondWorkflowId,
  user,
  userId,
  workflowId,
  workspaceId,
  workspaceWith,
} from '../../list/fixtures';

export const workspace = accessibleWorkspaceSchema.parse(
  workspaceWith(['workflow:read', 'workflow:update']),
);

/** A workspace as the server lists it for a role: with that role's grants. */
export function workspaceAs(
  role: AccessibleWorkspace['role'],
  overrides: Partial<AccessibleWorkspace> = {},
): AccessibleWorkspace {
  return {
    ...workspace,
    role,
    capabilities: capabilitiesForRole(role),
    ...overrides,
  };
}

const apiClient = createApiClient({
  fetch: testFetch,
  readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
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

type Answer = Response | Promise<Response> | 'network';

/** A command request as the server received it. */
export type SentCommand = Readonly<{
  path: string;
  key: string | null;
  body: unknown;
  signal: AbortSignal;
}>;

export type CommandServer = {
  /** Every organization command that reached the server, in order. */
  sent: SentCommand[];
  /** Identity and workspace reads, counted for freshness checks. */
  reads: { identity: number; discovery: number };
  /** The next answers, in order; then the receipt (or bulk echo). */
  answers: Answer[];
  /** The workspace list each discovery read returns, in order; then the last. */
  discoveries: (readonly AccessibleWorkspace[])[];
};

/**
 * Serves the person, their workspaces and the organization commands over
 * HTTP, recording what the commands sent.
 */
export function serveCommands(
  discoveries: (readonly AccessibleWorkspace[])[] = [[workspace]],
): CommandServer {
  const server: CommandServer = {
    sent: [],
    reads: { identity: 0, discovery: 0 },
    answers: [],
    discoveries,
  };
  async function answer(request: Request, fallback: unknown) {
    server.sent.push({
      path: new URL(request.url).pathname,
      key: request.headers.get('idempotency-key'),
      body: await request.clone().json(),
      signal: request.signal,
    });
    const next = server.answers.shift();
    if (next === 'network') return HttpResponse.error();
    return next ?? HttpResponse.json(fallback);
  }
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => {
      server.reads.identity += 1;
      return HttpResponse.json(user);
    }),
    http.get('http://pertexo.test/v1/workspaces', () => {
      server.reads.discovery += 1;
      const items =
        server.discoveries.length > 1
          ? server.discoveries.shift()
          : server.discoveries[0];
      return HttpResponse.json({ items, nextCursor: null });
    }),
    http.post(`${api}/workflows/:workflowId/folder`, ({ request }) =>
      answer(request, receipt),
    ),
    http.post(`${api}/workflows/organization/bulk`, ({ request }) =>
      answer(request, { items: [] }),
    ),
  );
  return server;
}

export function problem(status: number, code: string, detail = 'private') {
  return HttpResponse.json(
    {
      type: `urn:pertexo:problem:${code}`,
      title: 'Refused',
      status,
      code,
      detail,
      requestId: 'organization-command',
    },
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** An answer the test releases when it chooses. */
export function deferred(body: unknown = receipt) {
  let release!: () => void;
  const answer = new Promise<Response>((done) => {
    release = () => {
      done(HttpResponse.json(body));
    };
  });
  return { answer, release };
}

/** Another tab says the sign-in changed, as the session sync broadcasts. */
export function signalSessionChange() {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'pertexo:auth-session-change',
      newValue: JSON.stringify({
        event: 'changed',
        generation: crypto.randomUUID(),
        sender: 'another-tab',
      }),
    }),
  );
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
