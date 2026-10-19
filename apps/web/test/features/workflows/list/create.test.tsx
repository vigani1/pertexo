import { HttpResponse, http } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CURATED_WORKFLOW_TEMPLATES } from '@pertexo/templates';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import {
  api,
  createdResponse,
  curatedCatalog,
  discoveryHandlers,
  draftHandler,
  summary,
  workflowId,
  workspaceId,
  organizedPage,
} from './fixtures';

function emptyList() {
  return http.get(`${api}/workflows`, () =>
    HttpResponse.json(organizedPage({ items: [], nextCursor: null })),
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
        HttpResponse.json(
          organizedPage({
            items: [summary(workflowId, 'Daily intake')],
            nextCursor: null,
          }),
        ),
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

function exampleHandlers() {
  return http.get('http://pertexo.test/v1/node-definitions', () =>
    HttpResponse.json(curatedCatalog()),
  );
}

const [first, , controlled] = CURATED_WORKFLOW_TEMPLATES;
if (first === undefined || controlled === undefined)
  throw new Error('Missing curated examples');

describe('ready-made examples', () => {
  it('lists every example under the name and opens the chosen one set up, closing New workflow', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      http.get(`${api}/workflows`, () =>
        HttpResponse.json(
          organizedPage({
            items: [summary(workflowId, 'Daily intake')],
            nextCursor: null,
          }),
        ),
      ),
    );
    // After the discovery handlers, so the curated catalog answers first.
    mockServer.use(exampleHandlers());
    const { router } = renderApp(`/w/${workspaceId}/workflows?create=true`);
    const event = userEvent.setup();
    const sheet = await screen.findByRole('dialog', { name: 'New workflow' });
    for (const template of CURATED_WORKFLOW_TEMPLATES)
      expect(
        within(sheet).getByRole('button', {
          name: new RegExp(`^${template.title}`, 'u'),
        }),
      ).toBeVisible();
    await event.click(
      within(sheet).getByRole('button', {
        name: new RegExp(`^${controlled.title}`, 'u'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Start from an example',
    });
    await waitFor(() => {
      expect(within(dialog).getByLabelText('New workflow name')).toHaveValue(
        controlled.title,
      );
    });
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
  });

  it('offers the same examples beside Start blank on an empty list', async () => {
    mockServer.use(...discoveryHandlers(), emptyList());
    mockServer.use(exampleHandlers());
    renderApp(`/w/${workspaceId}/workflows`);
    const event = userEvent.setup();
    const empty = await screen.findByRole('region', {
      name: 'Weave your first workflow',
    });
    for (const template of CURATED_WORKFLOW_TEMPLATES)
      expect(
        within(empty).getByRole('button', {
          name: new RegExp(`^${template.title}`, 'u'),
        }),
      ).toBeVisible();
    await event.click(
      within(empty).getByRole('button', {
        name: new RegExp(`^${first.title}`, 'u'),
      }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Start from an example' }),
    ).toBeVisible();
  });
});
