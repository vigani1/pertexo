import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { createApiClient } from '@/lib/api/client';
import { useEditorSavePipeline } from '@/features/workflow-editor/hooks/use-editor-save-pipeline';
import { createEditorStore } from '@/features/workflow-editor/model/state/workflow-editor.store';
import { mockServer } from '../../support/mock-server';
import { testFetch } from '../../support/render-app';
import {
  draftBody,
  etagA,
  etagB,
  userId,
  workspaceId,
  workflowId,
  workflowApi,
} from '../../support/fixtures/workflow-editor';

it.each(['queued', 'accepted'] as const)(
  'automatically saves a %s edit after verification resumes',
  async (phase) => {
    const graph = { nodes: [], edges: [], settings: {} };
    const changed = { ...graph, settings: { maxRunDurationMs: 60000 } };
    const store = createEditorStore({ graph, etag: etagA, revision: 1 });
    let remote = graph;
    let revision = 1;
    let started = false;
    mockServer.use(
      http.put(`${workflowApi}/draft`, async ({ request }) => {
        started = true;
        if (phase === 'accepted' && revision === 1) {
          remote = changed;
          revision = 2;
          await new Promise<void>((resolve) => {
            request.signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              {
                once: true,
              },
            );
          });
          return HttpResponse.error();
        }
        if (
          request.headers.get('if-match') !== (revision === 1 ? etagA : etagB)
        )
          return HttpResponse.json(
            {
              type: 'urn:pertexo:problem:workflow.revision_conflict',
              title: 'Conflict',
              status: 412,
              code: 'workflow.revision_conflict',
              requestId: 'resumed-save',
              currentRevision: revision,
              currentEtag: etagB,
            },
            { status: 412 },
          );
        remote = changed;
        revision = 2;
        return HttpResponse.json(draftBody(remote, revision), {
          headers: { etag: etagB },
        });
      }),
      http.get(`${workflowApi}/draft`, () =>
        HttpResponse.json(draftBody(remote, revision), {
          headers: { etag: revision === 1 ? etagA : etagB },
        }),
      ),
    );
    const apiClient = createApiClient({
      fetch: testFetch,
      readCsrfToken: () =>
        'csrf-token-for-component-tests-12345678901234567890',
    });
    const queryClient = createQueryClient();
    const verifyOwner = () => Promise.resolve();
    const hook = renderHook(
      ({ paused }) =>
        useEditorSavePipeline({
          apiClient,
          store,
          userId,
          workspaceId,
          workflowId,
          canUpdate: true,
          paused,
          verifyOwner,
        }),
      {
        initialProps: { paused: false },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        ),
      },
    );
    act(() => {
      store.getState().transact(changed);
    });
    if (phase === 'accepted')
      await waitFor(
        () => {
          expect(started).toBe(true);
        },
        { timeout: 3000 },
      );
    hook.rerender({ paused: true });
    hook.rerender({ paused: false });
    await waitFor(
      () => {
        expect(store.getState().save.status).toBe('clean');
      },
      {
        timeout: 4000,
      },
    );
    expect(remote).toEqual(changed);
    expect(store.getState().revision).toBe(2);
  },
);
