import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../../support/mock-server';

import { renderApp } from '../../../../support/render-app';

import {
  api,
  discoveryHandlers,
  draftHandler,
  graphOf,
  organizedPage,
  secondWorkflowId,
  summary,
  workflowId,
  workspaceId,
} from '../fixtures';

import { archiveAgainstProblem, listHandler } from './fixture';

describe('workflow list', () => {
  it('archives from the row menu after spelling out the consequences', async () => {
    const requests: { key: string | null; body: unknown }[] = [];
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'workflow:publish']),
      draftHandler(),
      listHandler(() => ({
        items: [
          summary(workflowId, 'Invoice intake', { lifecycleRevision: 4 }),
        ],
        nextCursor: null,
      })),
      http.post(
        `${api}/workflows/${workflowId}/archive`,
        async ({ request }) => {
          requests.push({
            key: request.headers.get('idempotency-key'),
            body: await request.json(),
          });
          return HttpResponse.json({
            workflow: summary(workflowId, 'Invoice intake', {
              lifecycleStatus: 'archived',
              lifecycleRevision: 5,
            }),
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
    expect(
      await screen.findByRole('menuitem', { name: 'Triggers' }),
    ).toHaveAttribute(
      'href',
      `/w/${workspaceId}/workflows/${workflowId}/triggers`,
    );
    await event.click(screen.getByRole('menuitem', { name: 'Archive…' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive this workflow?',
    });
    expect(dialog).toHaveTextContent(
      'Runs already in progress finish normally.',
    );
    await event.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Workflow archived')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBeTruthy();
    expect(requests[0]?.body).toEqual({ expectedLifecycleRevision: 4 });
  });
  it('lists published parents before a child archive and keeps confirmation blocked when that read fails', async () => {
    let allowRead = false;
    mockServer.use(
      ...discoveryHandlers(['workflow:create', 'workflow:publish']),
      draftHandler(),
      http.get(`${api}/workflows`, ({ request }) => {
        if (
          new URL(request.url).searchParams.get('pinsWorkflowId') === workflowId
        )
          return allowRead
            ? HttpResponse.json({
                items: [summary(secondWorkflowId, 'Published invoice parent')],
                nextCursor: null,
              })
            : new HttpResponse(null, { status: 503 });
        return HttpResponse.json(
          organizedPage({
            items: [summary(workflowId, 'Child workflow')],
            nextCursor: null,
          }),
        );
      }),
    );
    renderApp(`/w/${workspaceId}/workflows`, { strict: true });
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Actions for Child workflow' }),
    );
    await event.click(
      await screen.findByRole('menuitem', { name: 'Archive…' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Archive this workflow?',
    });
    expect(
      await within(dialog).findByText(
        'Published parents couldn’t be loaded. Try again.',
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Archive' }),
    ).toBeDisabled();
    allowRead = true;
    await event.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(
      await within(dialog).findByText('Published invoice parent'),
    ).toBeVisible();
    expect(dialog).toHaveTextContent('Already accepted child runs continue.');
    await waitFor(() =>
      expect(
        within(dialog).getByRole('button', { name: 'Archive' }),
      ).toBeEnabled(),
    );
  });
  it('reports a stale archive as a conflict and confirms again with a new key', async () => {
    const { dialog, event, keys } = await archiveAgainstProblem({
      code: 'workflow.lifecycle_conflict',
      title: 'Workflow lifecycle changed',
      extra: { currentLifecycleRevision: 5 },
    });
    expect(
      await within(dialog).findByText(
        /This workflow changed since you opened/u,
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/couldn’t confirm/u)).toBeNull();
    await event.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => {
      expect(keys).toHaveLength(2);
    });
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
  it('does not call a reused request key a workflow change', async () => {
    const { dialog } = await archiveAgainstProblem({
      code: 'request.idempotency_conflict',
      title: 'Idempotency key reused',
    });
    expect(
      await within(dialog).findByText(
        'This request was already used with different details. Try again.',
      ),
    ).toBeVisible();
    expect(within(dialog).queryByText(/This workflow changed/u)).toBeNull();
  });
  it('keeps archive out of the menu for people who can’t publish', async () => {
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      listHandler(() => ({
        items: [summary(workflowId, 'Invoice intake')],
        nextCursor: null,
      })),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    await userEvent.setup().click(
      await screen.findByRole('button', {
        name: 'Actions for Invoice intake',
      }),
    );
    expect(
      await screen.findByRole('menuitem', { name: 'Copy ID' }),
    ).toBeVisible();
    expect(
      screen.queryByRole('menuitem', { name: 'Archive…' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'Runs' }),
    ).not.toBeInTheDocument();
  });
  it('explains a failed first load and recovers on retry', async () => {
    let failing = true;
    mockServer.use(
      ...discoveryHandlers(),
      draftHandler(),
      // The route's warm-up read and any mount retry fail until Try again.
      http.get(`${api}/workflows`, () =>
        failing
          ? HttpResponse.json({}, { status: 500 })
          : HttpResponse.json(
              organizedPage({
                items: [summary(workflowId, 'Daily intake')],
                nextCursor: null,
              }),
            ),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows`);
    expect(
      await screen.findByRole('heading', { name: 'Workflows didn’t load' }),
    ).toBeVisible();
    failing = false;
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Daily intake')).toBeVisible();
  });
});

it('shows Form and error-workflow trigger icons with accessible names', async () => {
  mockServer.use(
    ...discoveryHandlers(),
    draftHandler({
      [workflowId]: graphOf([{ id: 'form', key: 'core.form', x: 0 }]),
      [secondWorkflowId]: graphOf([
        { id: 'error', key: 'core.workflow_error', x: 0 },
      ]),
    }),
    listHandler(() => ({
      items: [
        summary(workflowId, 'Request form'),
        summary(secondWorkflowId, 'Failure responder'),
      ],
      nextCursor: null,
    })),
  );
  renderApp(`/w/${workspaceId}/workflows`);
  const list = await screen.findByRole('list', { name: 'Workflows' });
  expect(
    (await within(list).findAllByText('Triggers: Form'))[0],
  ).toBeInTheDocument();
  expect(
    (await within(list).findAllByText('Triggers: When a workflow fails'))[0],
  ).toBeInTheDocument();
});
