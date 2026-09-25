import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  discoveryHandlers,
  draftHandler,
  summary as listSummary,
} from './workflow-list.fixtures';
import {
  api,
  defaultCapabilities,
  installQueries,
  summary,
  workflowApi,
  workflowId,
  workspaceId,
} from './workflow-settings.fixtures';

const versionsPath = `/w/${workspaceId}/workflows/${workflowId}/versions`;
const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;

type Summary = typeof summary;

function nameConflict(currentNameRevision: number) {
  return HttpResponse.json(
    {
      type: 'urn:pertexo:problem:workflow.name_conflict',
      title: 'Workflow name conflict',
      status: 409,
      code: 'workflow.name_conflict',
      requestId: 'request-name-conflict',
      currentNameRevision,
    },
    { status: 409, headers: { 'content-type': 'application/problem+json' } },
  );
}

/** The workflow read answers with whatever `current()` holds now. */
function summaryHandler(current: () => Summary) {
  return http.get(workflowApi, () =>
    HttpResponse.json({ workflow: current() }),
  );
}

async function startRenaming(name: string) {
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Rename workflow' }),
  );
  const input = screen.getByLabelText('Workflow name');
  await event.clear(input);
  await event.type(input, name);
  return { event, input };
}

describe('workflow rename', () => {
  it('renames in place from the hub bar and keeps Cancel and invalid names local', async () => {
    let current = summary;
    const requests: { key: string | null; body: unknown }[] = [];
    installQueries();
    mockServer.use(
      summaryHandler(() => current),
      http.post(`${workflowApi}/rename`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        requests.push({ key: request.headers.get('idempotency-key'), body });
        current = { ...summary, name: body.name, nameRevision: 2 };
        return HttpResponse.json({ workflow: current, replayed: false });
      }),
    );
    renderApp(versionsPath);

    const cancelled = await startRenaming('Not this one');
    await cancelled.event.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Daily control' }),
    ).toBeVisible();

    const { event, input } = await startRenaming('   ');
    await event.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Name the workflow in 1 to 128 characters.'),
    ).toBeVisible();
    expect(requests).toHaveLength(0);

    await event.clear(input);
    await event.type(input, '  Daily controls ');
    await event.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Renamed to Daily controls')).toBeVisible();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Daily controls' }),
    ).toBeVisible();
    expect(requests.map(({ body }) => body)).toEqual([
      { name: 'Daily controls', expectedNameRevision: 1 },
    ]);
    expect(requests[0]?.key).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('retries an unconfirmed rename exactly, then lets people keep their name over a newer one', async () => {
    let current = summary;
    const keys: (string | null)[] = [];
    const bodies: unknown[] = [];
    installQueries();
    mockServer.use(
      summaryHandler(() => current),
      http.post(`${workflowApi}/rename`, async ({ request }) => {
        keys.push(request.headers.get('idempotency-key'));
        bodies.push(await request.json());
        if (keys.length === 1) return HttpResponse.error();
        if (keys.length === 2) {
          current = { ...summary, name: 'Daily checks', nameRevision: 2 };
          return nameConflict(2);
        }
        current = { ...summary, name: 'Morning control', nameRevision: 3 };
        return HttpResponse.json({ workflow: current, replayed: false });
      }),
    );
    renderApp(versionsPath);

    const { event } = await startRenaming('Morning control');
    await event.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        /couldn’t confirm whether the rename went through/u,
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('Workflow name')).toBeDisabled();

    await event.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Renamed to “Daily checks” meanwhile.'),
    ).toBeVisible();
    expect(keys[1]).toBe(keys[0]);

    await event.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(await screen.findByText('Renamed to Morning control')).toBeVisible();
    expect(keys[2]).not.toBe(keys[0]);
    expect(bodies).toEqual([
      { name: 'Morning control', expectedNameRevision: 1 },
      { name: 'Morning control', expectedNameRevision: 1 },
      { name: 'Morning control', expectedNameRevision: 2 },
    ]);
  });

  it('uses the newer name when people choose theirs after a conflict', async () => {
    let current = summary;
    let renames = 0;
    installQueries();
    mockServer.use(
      summaryHandler(() => current),
      http.post(`${workflowApi}/rename`, () => {
        renames += 1;
        current = { ...summary, name: 'Daily checks', nameRevision: 2 };
        return nameConflict(2);
      }),
    );
    renderApp(settingsPath);
    const identity = await screen.findByRole('region', { name: 'Identity' });
    const event = userEvent.setup();
    await event.click(
      await within(identity).findByRole('button', { name: 'Rename workflow' }),
    );
    const input = within(identity).getByLabelText('Workflow name');
    await event.clear(input);
    await event.type(input, 'Evening control');
    await event.click(within(identity).getByRole('button', { name: 'Save' }));
    expect(
      await within(identity).findByText('Renamed to “Daily checks” meanwhile.'),
    ).toBeVisible();
    await event.click(
      within(identity).getByRole('button', { name: 'Use theirs' }),
    );
    expect(within(identity).getByText('Daily checks')).toBeVisible();
    expect(
      within(identity).queryByLabelText('Workflow name'),
    ).not.toBeInTheDocument();
    expect(renames).toBe(1);
  });

  it('offers no rename for archived workflows or roles that cannot edit', async () => {
    installQueries();
    mockServer.use(
      summaryHandler(() => ({ ...summary, lifecycleStatus: 'archived' })),
    );
    const archived = renderApp(settingsPath);
    const identity = await screen.findByRole('region', { name: 'Identity' });
    expect(
      await within(identity).findByText(
        'How this workflow is known. Restore it to rename it.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Rename workflow' }),
    ).not.toBeInTheDocument();
    archived.unmount();

    installQueries(
      defaultCapabilities.filter(
        (capability) => capability !== 'workflow:update',
      ),
    );
    renderApp(settingsPath);
    expect(
      await within(
        await screen.findByRole('region', { name: 'Identity' }),
      ).findByText('Daily control'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Rename workflow' }),
    ).not.toBeInTheDocument();
  });

  it('renames from the workflow row menu and refreshes the list', async () => {
    let name = 'Invoice intake';
    const bodies: unknown[] = [];
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'workflow:update']),
      draftHandler(),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json({
          items: [listSummary(workflowId, name)],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/workflows/${workflowId}`, () =>
        HttpResponse.json({ workflow: listSummary(workflowId, name) }),
      ),
      http.post(
        `${api}/workflows/${workflowId}/rename`,
        async ({ request }) => {
          bodies.push(await request.json());
          name = 'Invoice sync';
          return HttpResponse.json({
            workflow: listSummary(workflowId, name, { nameRevision: 2 }),
            replayed: false,
          });
        },
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Actions for Invoice intake' }),
    );
    await event.click(await screen.findByRole('menuitem', { name: 'Rename…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Rename workflow',
    });
    const input = within(dialog).getByLabelText('Workflow name');
    expect(input).toHaveValue('Invoice intake');
    await event.clear(input);
    await event.type(input, 'Invoice sync');
    await event.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Renamed to Invoice sync')).toBeVisible();
    await waitFor(() => {
      expect(
        screen.queryByRole('dialog', { name: 'Rename workflow' }),
      ).not.toBeInTheDocument();
    });
    expect(
      await within(screen.getByRole('list', { name: 'Workflows' })).findByRole(
        'link',
        { name: 'Invoice sync' },
      ),
    ).toBeVisible();
    expect(bodies).toEqual([{ name: 'Invoice sync', expectedNameRevision: 1 }]);
  });
});
