import { HttpResponse, http } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const workflowId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const workflowVersionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sourceRunId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const replayRunId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const timestamp = '2026-09-15T10:00:00.000Z';

const user = {
  id: userId,
  email: 'operator@example.test',
  displayName: 'Pertexo Operator',
  status: 'active',
  createdAt: timestamp,
  updatedAt: timestamp,
};

const workspace = {
  id: workspaceId,
  name: 'Control Operations',
  slug: 'control-operations',
  status: 'active',
  role: 'operator',
  capabilities: ['workspace:read', 'run:read', 'run:replay'],
  createdAt: timestamp,
  updatedAt: timestamp,
};

function run(id: string, triggerType: 'manual' | 'replay' = 'manual') {
  return {
    id,
    workspaceId,
    workflowId,
    workflowVersionId,
    status: 'failed',
    triggerType,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: '2026-09-15T10:00:02.000Z',
    deadlineAt: null,
    cancelRequestedAt: null,
  };
}

function installRunHandlers(currentWorkspace: unknown = workspace) {
  mockServer.use(
    http.get('http://pertexo.test/v1/users/me', () => HttpResponse.json(user)),
    http.get('http://pertexo.test/v1/workspaces', () =>
      HttpResponse.json({ items: [currentWorkspace], nextCursor: null }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/runs/:runId`,
      ({ params }) =>
        HttpResponse.json({
          run: run(
            String(params.runId),
            params.runId === replayRunId ? 'replay' : 'manual',
          ),
          nodes: [],
        }),
    ),
    http.get(
      `http://pertexo.test/v1/workspaces/${workspaceId}/runs/:runId/events`,
      () =>
        new HttpResponse(
          `id: 1\nevent: run.failed\ndata: ${JSON.stringify({
            sequence: 1,
            type: 'run.failed',
            createdAt: timestamp,
            payload: { schemaVersion: 1 },
          })}\n\n`,
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    ),
  );
}

describe('run replay', () => {
  it('associates replay validation with the input and focuses it', async () => {
    installRunHandlers();
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Replay run' }),
    );
    const input = screen.getByLabelText('Replay input (JSON)');
    fireEvent.change(input, { target: { value: '{' } });
    await event.click(
      screen.getByRole('button', { name: 'Replay this version' }),
    );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      /Replay input must be valid JSON/u,
    );
    fireEvent.change(input, { target: { value: '{}' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('preserves the exact replay after an uncertain result and navigates to the accepted run', async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    installRunHandlers();
    mockServer.use(
      http.post(
        `http://pertexo.test/v1/workspaces/${workspaceId}/runs/${sourceRunId}/replay`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          bodies.push(await request.json());
          if (keys.length === 1) return HttpResponse.error();
          return HttpResponse.json(
            { run: run(replayRunId, 'replay'), replayed: true },
            { status: 202 },
          );
        },
      ),
    );

    const { router } = renderApp(`/w/${workspaceId}/runs/${sourceRunId}`, {
      strict: true,
    });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Replay run' }),
    );
    const input = screen.getByLabelText('Replay input (JSON)');
    fireEvent.change(input, { target: { value: '{"b":2,"a":1}' } });
    await event.click(
      screen.getByRole('button', { name: 'Replay this version' }),
    );
    expect(
      await screen.findByText(
        'The replay result is uncertain. Retry the same values to reuse this command safely.',
      ),
    ).toBeVisible();

    fireEvent.change(input, { target: { value: '{"a":1, "b":2}' } });
    await event.click(
      screen.getByRole('button', { name: 'Retry same replay' }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${replayRunId}`,
      );
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({
      workflowVersionId,
      input: { a: 1, b: 2 },
    });
  });

  it('does not expose replay without its distinct capability', async () => {
    installRunHandlers({
      ...workspace,
      capabilities: ['workspace:read', 'run:read'],
    });
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    expect(
      await screen.findByRole('heading', { name: 'Workflow run' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Replay run' }),
    ).not.toBeInTheDocument();
  });
});
