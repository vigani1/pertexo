import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { accessibleWorkspaceSchema } from '@pertexo/contracts';
import { createQueryClient } from '@/app/query-client';
import { WorkflowTemplateOrigin } from '@/features/workflows/components/templates/workflow-template-origin';
import {
  workflowTemplateOriginKey,
  workflowTemplateOriginPresentationEnabled,
} from '@/features/workflows/workflow-origin.queries';
import { workflowKeys } from '@/features/workflows/workflows.queries';
import { createApiClient } from '@/lib/api/client';
import { ApiError } from '@/lib/api/api-error';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  api,
  discoveryHandlers,
  summary,
  secondWorkflowId,
  userId,
  workflowId,
  workspaceId,
  workspaceWith,
} from './workflow-list.fixtures';

const origin = {
  schemaVersion: 1,
  templateId: 'retired-reviewed-example',
  templateVersion: 7,
  baseManifestDigest: 'a'.repeat(64),
  creationCommandDigest: 'b'.repeat(64),
  derivation: 'inherited',
};

function mount() {
  mockServer.use(...discoveryHandlers());
  const queryClient = createQueryClient();
  const props = {
    apiClient: createApiClient({
      fetch: testFetch,
      readCsrfToken: () => undefined,
    }),
    userId,
    workspace: accessibleWorkspaceSchema.parse(workspaceWith([])),
    workflowId,
  };
  const view = (next = props) => (
    <QueryClientProvider client={queryClient}>
      <WorkflowTemplateOrigin {...next} />
    </QueryClientProvider>
  );
  return { ...render(view()), queryClient, props, view };
}

describe('Scoped historical template origin projection', () => {
  it.each([
    ['inbox', 403],
    ['inbox', 404],
    ['other-workflow', 403],
    ['other-workflow', 404],
  ] as const)(
    'keeps the authorized origin after unrelated %s %s',
    async (scope, status) => {
      mockServer.use(
        http.get(`${api}/workflows/${workflowId}`, () =>
          HttpResponse.json({
            workflow: summary(workflowId, 'Authorized'),
            templateOrigin: origin,
          }),
        ),
      );
      const { queryClient } = mount();
      await screen.findByText(/Originally based on/u);
      const queryKey =
        scope === 'inbox'
          ? ['identity', userId, 'workspace', workspaceId, 'inbox']
          : workflowKeys.detail(userId, workspaceId, secondWorkflowId);
      await act(async () => {
        await queryClient
          .query({
            queryKey,
            queryFn: () =>
              Promise.reject(
                new ApiError({
                  kind: 'problem',
                  message: 'Unrelated denial',
                  status,
                }),
              ),
            retry: false,
          })
          .catch(() => undefined);
      });
      expect(screen.getByText(/Originally based on/u)).toBeInTheDocument();
      expect(screen.queryByText(/access changed/u)).not.toBeInTheDocument();
      expect(
        queryClient.getQueryData(
          workflowTemplateOriginKey(userId, workspaceId, workflowId),
        ),
      ).toMatchObject({ templateOrigin: origin });
    },
  );
  it.each([
    ['workspace', 403],
    ['workspace', 404],
    ['workflow', 403],
    ['workflow', 404],
    ['origin', 403],
    ['origin', 404],
    ['inbox', 401],
    ['other-workflow', 401],
    ['session', 0],
  ] as const)(
    'retires cached metadata for relevant %s %s',
    async (scope, status) => {
      mockServer.use(
        http.get(`${api}/workflows/${workflowId}`, () =>
          HttpResponse.json({
            workflow: summary(workflowId, 'Authorized'),
            templateOrigin: origin,
          }),
        ),
      );
      const { queryClient } = mount();
      await screen.findByText(/Originally based on/u);
      act(() => {
        if (scope === 'session') {
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'pertexo:auth-session-change:v1',
              newValue: JSON.stringify({
                event: 'changed',
                generation: crypto.randomUUID(),
                sender: 'another-tab',
              }),
            }),
          );
          return;
        }
        const queryKey =
          scope === 'workspace'
            ? ['identity', userId, 'workspace', workspaceId]
            : scope === 'workflow'
              ? workflowKeys.detail(userId, workspaceId, workflowId)
              : scope === 'origin'
                ? workflowTemplateOriginKey(userId, workspaceId, workflowId)
                : scope === 'other-workflow'
                  ? workflowKeys.detail(userId, workspaceId, secondWorkflowId)
                  : ['identity', userId, 'workspace', workspaceId, 'inbox'];
        // Inject the same cache notification as a failed scoped read, without
        // replacing the live origin query's authority-checked request function.
        const query = queryClient
          .getQueryCache()
          .build(queryClient, { queryKey });
        query.setState({
          error: new ApiError({
            kind: 'problem',
            message: 'Authority lost',
            status,
          }),
        });
      });
      await screen.findByText('Template origin unavailable: access changed.');
      expect(
        screen.queryByText(/Originally based on/u),
      ).not.toBeInTheDocument();
      expect(
        queryClient.getQueryData(
          workflowTemplateOriginKey(userId, workspaceId, workflowId),
        ),
      ).toBeUndefined();
    },
  );
  it.each(['identity', 'workspace'] as const)(
    'fences a late origin read when %s changes',
    async (scope) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      mockServer.use(
        http.get(`${api}/workflows/${workflowId}`, async () => {
          started = true;
          await held;
          return HttpResponse.json({
            workflow: summary(workflowId, 'Old scope'),
            templateOrigin: origin,
          });
        }),
      );
      const { props, view, rerender, queryClient } = mount();
      await waitFor(() => {
        expect(started).toBe(true);
      });
      rerender(
        view(
          scope === 'identity'
            ? { ...props, userId: secondWorkflowId }
            : {
                ...props,
                workspace: { ...props.workspace, id: secondWorkflowId },
              },
        ),
      );
      await screen.findByText(/Template origin unavailable/u);
      await act(async () => {
        release();
        await held;
      });
      expect(
        screen.queryByText(/Originally based on/u),
      ).not.toBeInTheDocument();
      expect(
        queryClient.getQueryData(
          workflowTemplateOriginKey(userId, workspaceId, workflowId),
        ),
      ).toBeUndefined();
    },
  );
  it('keeps presentation gated off and projection keys within existing invalidation scope', () => {
    expect(workflowTemplateOriginPresentationEnabled()).toBe(false);
    expect(
      workflowTemplateOriginKey(userId, workspaceId, workflowId).slice(0, 5),
    ).toEqual(workflowKeys.scope(userId, workspaceId));
    expect(
      workflowTemplateOriginKey(userId, workspaceId, workflowId),
    ).not.toEqual(workflowKeys.detail(userId, workspaceId, workflowId));
  });

  it('reads a retired historical basis without looking up current assets and does not mutate it after rename/edit invalidation', async () => {
    let name = 'Original name';
    const requests: string[] = [];
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}`, ({ request }) => {
        requests.push(request.method);
        expect(new URL(request.url).search).toBe('?include=templateOrigin');
        expect(request.headers.get('cache-control')).toBe('no-store');
        return HttpResponse.json({
          workflow: summary(workflowId, name),
          templateOrigin: origin,
        });
      }),
    );
    const { queryClient } = mount();
    await screen.findByText(
      /Originally based on retired-reviewed-example, version 7 \(inherited\)/u,
    );
    name = 'Renamed and edited graph';
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowKeys.scope(userId, workspaceId),
      });
    });
    await screen.findByText(
      /Originally based on retired-reviewed-example, version 7/u,
    );
    expect(
      queryClient.getQueryData(
        workflowTemplateOriginKey(userId, workspaceId, workflowId),
      ),
    ).toMatchObject({ templateOrigin: origin });
    expect(requests).toEqual(['GET', 'GET']);
  });

  it('renders authoritative null distinctly', async () => {
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}`, () =>
        HttpResponse.json({
          workflow: summary(workflowId, 'Ordinary import'),
          templateOrigin: null,
        }),
      ),
    );
    mount();
    await screen.findByText('No recorded template origin.');
    expect(screen.queryByText(/unavailable/u)).not.toBeInTheDocument();
  });

  it.each([
    'missing-projection',
    'unknown-version',
    'unsupported',
    'unavailable',
  ] as const)('does not infer null from %s', async (failure) => {
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}`, () => {
        if (failure === 'missing-projection')
          return HttpResponse.json(summary(workflowId, 'Old reader'));
        if (failure === 'unknown-version')
          return HttpResponse.json({
            workflow: summary(workflowId, 'Future reader'),
            templateOrigin: { ...origin, schemaVersion: 2 },
          });
        return HttpResponse.json(
          {},
          { status: failure === 'unsupported' ? 400 : 503 },
        );
      }),
    );
    mount();
    await screen.findByText(/Template origin unavailable\./u);
    expect(
      screen.queryByText('No recorded template origin.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Originally based on/u)).not.toBeInTheDocument();
  });

  it.each(['workflow', 'session'] as const)(
    'fences a held successful origin response after %s authority loss',
    async (scope) => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started = false;
      mockServer.use(
        http.get(`${api}/workflows/${workflowId}`, async () => {
          started = true;
          await held;
          return HttpResponse.json({
            workflow: summary(workflowId, 'Held'),
            templateOrigin: origin,
          });
        }),
      );
      const { queryClient } = mount();
      await waitFor(() => {
        expect(started).toBe(true);
      });
      await act(async () => {
        if (scope === 'session') {
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: 'pertexo:auth-session-change:v1',
              newValue: JSON.stringify({
                event: 'changed',
                generation: crypto.randomUUID(),
                sender: 'another-tab',
              }),
            }),
          );
          return;
        }
        await queryClient
          .query({
            queryKey: workflowKeys.detail(userId, workspaceId, workflowId),
            queryFn: () =>
              Promise.reject(
                new ApiError({
                  kind: 'problem',
                  message: 'Denied',
                  status: 403,
                }),
              ),
            retry: false,
          })
          .catch(() => undefined);
      });
      await screen.findByText('Template origin unavailable: access changed.');
      await act(async () => {
        release();
        await held;
      });
      expect(
        screen.queryByText(/Originally based on/u),
      ).not.toBeInTheDocument();
      expect(
        queryClient.getQueryData(
          workflowTemplateOriginKey(userId, workspaceId, workflowId),
        ),
      ).toBeUndefined();
    },
  );
});
