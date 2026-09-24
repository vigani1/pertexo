import { useState } from 'react';
import { HttpResponse, http } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '@/app/query-client';
import { NotificationsProvider } from '@/components/ui/toast';
import { NewWorkflowSheet } from '@/features/workflows/components/new-workflow-sheet';
import type { StartChoice } from '@/features/workflows/components/starter-choice';
import { availableStarters } from '@/features/workflows/model/workflow-starters';
import type { StarterDraftWriter } from '@/features/workflows/list.public';
import { ApiError } from '@/lib/api/api-error';
import { createApiClient } from '@/lib/api/client';
import { mockServer } from '../support/mock-server';
import { renderApp, testFetch } from '../support/render-app';
import {
  api,
  catalogDefinition,
  catalogOf,
  createdResponse,
  discoveryHandlers,
  draftHandler,
  etag,
  summary,
  userId,
  workflowId,
  workspaceId,
} from './workflow-list.fixtures';

function emptyList() {
  return http.get(`${api}/workflows`, () =>
    HttpResponse.json({ items: [], nextCursor: null }),
  );
}

/** The Build tab after creation: its summary and draft reads. */
function buildTabHandlers() {
  return [
    http.get(`${api}/workflows/${workflowId}`, () =>
      HttpResponse.json({ workflow: summary(workflowId, 'Nightly sync') }),
    ),
    draftHandler(),
  ];
}

describe('new workflow lens', () => {
  it('validates the name, reuses one key for an uncertain retry, then opens Build', async () => {
    const keys: (string | null)[] = [];
    mockServer.use(
      ...discoveryHandlers(),
      ...buildTabHandlers(),
      emptyList(),
      http.post(`${api}/workflows`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        expect(request.headers.get('x-csrf-token')).toBe(
          'csrf-token-for-component-tests-12345678901234567890',
        );
        expect(await request.json()).toEqual({ name: 'Nightly sync' });
        if (keys.length === 1) return HttpResponse.error();
        return createdResponse(workflowId, 'Nightly sync');
      }),
    );
    const { router } = renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'Weave your first workflow' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'New workflow' }));
    expect(
      await screen.findByRole('dialog', { name: 'New workflow' }),
    ).toBeVisible();

    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    const name = screen.getByLabelText('Workflow name');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.getByText('Give the workflow a name your team will recognize.'),
    ).toBeVisible();

    await event.type(name, '  Nightly sync  ');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(
      await screen.findByText(
        /couldn’t confirm whether the workflow was created/u,
      ),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Retry safely' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/workflows/${workflowId}`,
      );
    });
    expect(await screen.findByText('Workflow created')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('freezes the submitted create intent while its request is pending', async () => {
    let releaseCreate: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let createCalls = 0;
    mockServer.use(
      ...discoveryHandlers(),
      ...buildTabHandlers(),
      emptyList(),
      http.post(`${api}/workflows`, async () => {
        createCalls += 1;
        await blocked;
        return createdResponse(workflowId, 'Pending workflow');
      }),
    );
    renderApp(`/w/${workspaceId}/workflows?create=true`);
    const event = userEvent.setup();
    const name = await screen.findByLabelText('Workflow name');
    await event.type(name, 'Pending workflow');
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    expect(name).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Creating…' })).toBeDisabled();
    await event.type(name, ' changed');
    expect(name).toHaveValue('Pending workflow');
    releaseCreate?.();
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'New workflow' }),
      ).not.toBeInTheDocument();
    });
    expect(createCalls).toBe(1);
  });

  it('opens from a deep link and from N, and closes back to the plain list', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({
          items: [summary(workflowId, 'Daily intake')],
          nextCursor: null,
        }),
      ),
    );
    const { router } = renderApp(`/w/${workspaceId}/workflows?create=true`);
    const event = userEvent.setup();
    expect(
      await screen.findByRole('dialog', { name: 'New workflow' }),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(
      screen.queryByRole('dialog', { name: 'New workflow' }),
    ).not.toBeInTheDocument();

    await event.keyboard('n');
    expect(
      await screen.findByRole('dialog', { name: 'New workflow' }),
    ).toBeVisible();
    expect(router.state.location.search).toEqual({ create: true });
  });

  it('keeps the empty state read-only without create capability', async () => {
    mockServer.use(...discoveryHandlers([]), emptyList());
    renderApp(`/w/${workspaceId}/workflows?create=true`);
    expect(
      await screen.findByRole('heading', { name: 'No workflows yet' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /new workflow/iu }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

const catalog = catalogOf([
  catalogDefinition('core.webhook', 'trigger'),
  catalogDefinition('http.request', 'action'),
  catalogDefinition('slack.send_message', 'action'),
  catalogDefinition('core.schedule', 'trigger', { available: false }),
]);

function StarterHarness({
  writer,
  onCreated,
}: Readonly<{
  writer: StarterDraftWriter;
  onCreated: (workflowId: string) => void;
}>) {
  const [choice, setChoice] = useState<StartChoice>('blank');
  const apiClient = createApiClient({
    fetch: testFetch,
    readCsrfToken: () => 'csrf-token-for-component-tests-12345678901234567890',
  });
  return (
    <NewWorkflowSheet
      apiClient={apiClient}
      userId={userId}
      workspaceId={workspaceId}
      open
      starters={availableStarters(catalog)}
      choice={choice}
      writer={writer}
      onChoiceChange={setChoice}
      onOpenChange={() => undefined}
      onCreated={onCreated}
    />
  );
}

function renderStarterLens(writer: StarterDraftWriter) {
  const onCreated = vi.fn<(workflowId: string) => void>();
  mockServer.use(
    http.post(`${api}/workflows`, () =>
      createdResponse(workflowId, 'Lead enrichment'),
    ),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <NotificationsProvider>
        <StarterHarness writer={writer} onCreated={onCreated} />
      </NotificationsProvider>
    </QueryClientProvider>,
  );
  return onCreated;
}

describe('starter patterns', () => {
  it('offers only starters the catalog can build and saves the chosen graph with the create ETag', async () => {
    const writer = vi.fn<StarterDraftWriter>(() => Promise.resolve());
    const onCreated = renderStarterLens(writer);
    const event = userEvent.setup();
    expect(screen.getByRole('radio', { name: /^Blank/u })).toBeChecked();
    expect(
      screen.queryByRole('radio', { name: /Schedule → HTTP/u }),
    ).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('radio', { name: /Webhook → HTTP → Slack/u }),
    );
    await event.type(screen.getByLabelText('Workflow name'), 'Lead enrichment');
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(workflowId);
    });
    const [, workspace, workflow, input] = writer.mock.calls[0] ?? [];
    expect(workspace).toBe(workspaceId);
    expect(workflow).toBe(workflowId);
    expect(input?.etag).toBe(etag);
    expect(input?.graph.nodes.map((node) => node.definition.key)).toEqual([
      'core.webhook',
      'http.request',
      'slack.send_message',
    ]);
    expect(input?.graph.edges).toHaveLength(2);
    expect(
      await screen.findByText('Lead enrichment · starter steps added'),
    ).toBeVisible();
  });

  it('still opens the new workflow when its starter steps fail to save', async () => {
    const writer = vi.fn<StarterDraftWriter>(() =>
      Promise.reject(new ApiError({ kind: 'network', message: 'offline' })),
    );
    const onCreated = renderStarterLens(writer);
    const event = userEvent.setup();
    await event.click(
      screen.getByRole('radio', { name: /Webhook → HTTP → Slack/u }),
    );
    await event.type(screen.getByLabelText('Workflow name'), 'Lead enrichment');
    await event.click(screen.getByRole('button', { name: 'Create workflow' }));
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(workflowId);
    });
    // Errors are announced assertively, so the title can appear twice.
    expect(
      (
        await screen.findAllByText(
          'We couldn’t confirm whether the starter steps were added',
        )
      )[0],
    ).toBeVisible();
  });
});
