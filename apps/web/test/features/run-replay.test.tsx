import { HttpResponse, http } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import { workflowRunKeys } from '@/features/workflow-runs/queries.public';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  identityHandlers,
  sseEvents,
  coldStart,
} from '../support/run-fixtures';

const {
  user: userId,
  workspace: workspaceId,
  version: workflowVersionId,
  firstRun: sourceRunId,
  replayRun: replayRunId,
} = fixtureIds;
const operator = ['workspace:read', 'run:read', 'run:replay'];

function run(id: string) {
  return fixtureRun(id, 'failed', {
    workflowName: null,
    triggerType: id === replayRunId ? 'replay' : 'manual',
  });
}

/** Command responses carry the plain run summary, without its name. */
function acceptedRun(id: string) {
  return Object.fromEntries(
    Object.entries(run(id)).filter(([key]) => key !== 'workflowName'),
  );
}

function installRunHandlers(capabilities: readonly string[] = operator) {
  mockServer.use(
    ...identityHandlers(capabilities),
    http.get(`${apiBase}/runs/:runId`, ({ params }) =>
      HttpResponse.json({ run: run(String(params.runId)), nodes: [] }),
    ),
    http.get(
      `${apiBase}/runs/:runId/events`,
      () =>
        new HttpResponse(sseEvents([{ type: 'run.failed' }]), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    ),
    http.get(`${apiBase}/runs`, () =>
      HttpResponse.json({ items: [], nextCursor: null }),
    ),
  );
}

async function openReplay() {
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Replay' }, coldStart),
  );
  return screen.findByRole('dialog', { name: 'Replay this run' });
}

describe('run replay', () => {
  it('ties replay validation to the input and focuses it', async () => {
    installRunHandlers();
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const dialog = await openReplay();
    const input = within(dialog).getByLabelText('Replay input (JSON)');
    fireEvent.change(input, { target: { value: '{' } });
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole('button', { name: 'Replay this version' }),
      );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/isn’t valid JSON/u);
    fireEvent.change(input, { target: { value: '{}' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('retries an unconfirmed replay with the same request and opens the new run', async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    installRunHandlers();
    mockServer.use(
      http.post(
        `${apiBase}/runs/${sourceRunId}/replay`,
        async ({ request }) => {
          keys.push(request.headers.get('idempotency-key') ?? '');
          bodies.push(await request.json());
          if (keys.length === 1) return HttpResponse.error();
          return HttpResponse.json(
            { run: acceptedRun(replayRunId), replayed: true },
            { status: 202 },
          );
        },
      ),
    );

    const { router } = renderApp(`/w/${workspaceId}/runs/${sourceRunId}`, {
      strict: true,
    });
    const dialog = await openReplay();
    const event = userEvent.setup();
    const input = within(dialog).getByLabelText('Replay input (JSON)');
    fireEvent.change(input, { target: { value: '{"b":2,"a":1}' } });
    await event.click(
      within(dialog).getByRole('button', { name: 'Replay this version' }),
    );
    expect(
      await within(dialog).findByText(
        /We couldn’t confirm whether the replay started/u,
      ),
    ).toBeVisible();

    fireEvent.change(input, { target: { value: '{"a":1, "b":2}' } });
    await event.click(
      within(dialog).getByRole('button', { name: 'Retry same replay' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${replayRunId}`,
      );
    });
    expect(await screen.findByText('Replay started')).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({ workflowVersionId, input: { a: 1, b: 2 } });
  });

  it('refreshes cached Home runs as soon as a replay is accepted', async () => {
    let attentionReads = 0;
    installRunHandlers();
    mockServer.use(
      http.post(`${apiBase}/runs/${sourceRunId}/replay`, () =>
        HttpResponse.json(
          { run: acceptedRun(replayRunId), replayed: false },
          { status: 202 },
        ),
      ),
      http.get(`${apiBase}/runs`, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        if (status === 'failed') attentionReads += 1;
        return HttpResponse.json({
          items: status === 'failed' ? [run(replayRunId)] : [],
          nextCursor: null,
        });
      }),
    );

    const { queryClient, router } = renderApp(
      `/w/${workspaceId}/runs/${sourceRunId}`,
    );
    const sample = { count: 0, more: false, runs: [] };
    queryClient.setQueryData(workflowRunKeys.attention(userId, workspaceId), {
      asOf: Date.now(),
      failed: sample,
      timedOut: sample,
      outcomeUnknown: sample,
    });
    const dialog = await openReplay();
    await userEvent
      .setup()
      .click(
        within(dialog).getByRole('button', { name: 'Replay this version' }),
      );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${replayRunId}`,
      );
    });
    await router.navigate({ to: '/w/$workspaceId', params: { workspaceId } });
    const attention = await screen.findByRole('region', {
      name: 'Needs attention',
    });
    expect(
      await within(attention).findByRole('link', { name: 'Open run' }),
    ).toHaveAttribute('href', `/w/${workspaceId}/runs/${replayRunId}`);
    expect(attentionReads).toBe(1);
  });

  it('does not offer replay without its own capability', async () => {
    installRunHandlers(['workspace:read', 'run:read']);
    renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Failed after 2.0 s' },
        coldStart,
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Replay' }),
    ).not.toBeInTheDocument();
  });
});
