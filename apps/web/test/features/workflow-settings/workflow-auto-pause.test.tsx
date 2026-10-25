import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';

import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { unpausedWorkflowSettings } from '../../support/fixtures/auto-pause';

import { mockServer } from '../../support/mock-server';

import { renderApp } from '../../support/render-app';

import { installQueries, workflowApi } from './fixtures';

import {
  openEditorFor,
  path,
  paused,
  sentence,
} from './workflow-auto-pause/fixture';

describe('workflow automatic pause controls', () => {
  it('does not rebase retained edits after an idempotency conflict, even if refreshed settings change', async () => {
    installQueries();
    let current = unpausedWorkflowSettings;
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.put(`${workflowApi}/auto-pause`, async ({ request }) => {
        bodies.push(await request.json());
        current = {
          ...current,
          thresholdOverride: 12,
          effectiveThreshold: 12,
          settingsRevision: 2,
        };
        return HttpResponse.json(
          {
            type: 'https://api.pertexo.test/problems/request.idempotency_conflict',
            title: 'Idempotency conflict',
            status: 409,
            code: 'request.idempotency_conflict',
            requestId: 'req-key-conflict',
          },
          {
            status: 409,
            headers: { 'content-type': 'application/problem+json' },
          },
        );
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', {
      name: 'Automatic pause',
    });
    await openEditorFor(event, 'Pause after failures in a row');
    const input = await within(section).findByRole('textbox', {
      name: 'Pause after failures in a row',
    });
    await event.type(input, '6');
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await within(section).findByText(
      'This request was already used with different details. Try again.',
    );
    await within(section).findByText(
      sentence('Schedules and webhooks pause after 12 failures in a row'),
    );
    expect(input).toHaveValue('6');
    expect(
      within(section).queryByText(/Your edits are kept/u),
    ).not.toBeInTheDocument();
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual({
      enabled: true,
      thresholdOverride: 6,
      expectedSettingsRevision: 1,
    });
  });
  it('keeps an exact retry after malformed HTTP 409 problem details without claiming a revision conflict', async () => {
    installQueries();
    let current = unpausedWorkflowSettings;
    const requests: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.put(`${workflowApi}/auto-pause`, async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        current = {
          ...current,
          thresholdOverride: 5,
          effectiveThreshold: 5,
          settingsRevision: 2,
        };
        if (requests.length === 1)
          return HttpResponse.json(
            { status: 409, code: 'workflow.auto_pause_settings_conflict' },
            {
              status: 409,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        return HttpResponse.json({ settings: current, replayed: true });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', {
      name: 'Automatic pause',
    });
    await openEditorFor(event, 'Pause after failures in a row');
    await event.type(
      await within(section).findByRole('textbox', {
        name: 'Pause after failures in a row',
      }),
      '5',
    );
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    expect(
      await within(section).findByText(
        /We couldn’t confirm whether saving auto-pause settings went through/u,
      ),
    ).toBeVisible();
    expect(
      within(section).queryByText(/Your edits are kept/u),
    ).not.toBeInTheDocument();
    await event.click(
      within(section).getByRole('button', { name: 'Retry same change' }),
    );
    await screen.findByText('Auto-pause settings saved');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]?.body).toEqual({
      enabled: true,
      thresholdOverride: 5,
      expectedSettingsRevision: 1,
    });
  });
  it('can retry an uncertain Resume after the refreshed workflow is already unpaused', async () => {
    installQueries();
    let current = paused;
    const requests: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.post(`${workflowApi}/resume`, async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        current = unpausedWorkflowSettings;
        return requests.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ settings: current, replayed: true });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Resume triggers' }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Retry Resume' }),
    );
    await screen.findByText('Workflow triggers resumed');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  });
  it('opts out without issuing Resume and can clear a workflow override', async () => {
    installQueries();
    let current: WorkflowAutoPauseSettings = {
      ...paused,
      thresholdOverride: 6,
      effectiveThreshold: 6,
    };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.put(`${workflowApi}/auto-pause`, async ({ request }) => {
        bodies.push(await request.json());
        current = {
          ...current,
          enabled: false,
          thresholdOverride: null,
          effectiveThreshold: 10,
          settingsRevision: 2,
        };
        return HttpResponse.json({ settings: current, replayed: false });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', {
      name: 'Automatic pause',
    });
    expect(within(section).queryByText(/enforcement/u)).toBeNull();
    await openEditorFor(event, 'Auto-pause for this workflow');
    await event.click(
      await within(section).findByRole('switch', {
        name: 'Auto-pause for this workflow',
      }),
    );
    await event.clear(
      within(section).getByRole('textbox', {
        name: 'Pause after failures in a row',
      }),
    );
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await screen.findByText('Auto-pause settings saved');
    expect(bodies).toEqual([
      { enabled: false, thresholdOverride: null, expectedSettingsRevision: 1 },
    ]);
    expect(screen.getByText('Schedules and webhooks are paused')).toBeVisible();
  });
  it('resumes with exact bigint revision and key, then reads current authority rather than a receipt', async () => {
    installQueries();
    let current = paused;
    let body: unknown;
    let key: string | null = null;
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.post(`${workflowApi}/resume`, async ({ request }) => {
        body = await request.json();
        key = request.headers.get('idempotency-key');
        expect(request.headers.get('x-csrf-token')).toBeTruthy();
        current = unpausedWorkflowSettings;
        return HttpResponse.json({ settings: paused, replayed: true });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    expect(
      await screen.findByText('Schedules and webhooks are paused'),
    ).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Resume triggers' }));
    await screen.findByText('Workflow triggers resumed');
    expect(body).toEqual({ expectedPauseRevision: '9007199254740993' });
    expect(key).toMatch(/^[a-f0-9-]{36}$/u);
    await waitFor(() =>
      expect(
        screen.queryByText('Schedules and webhooks are paused'),
      ).not.toBeInTheDocument(),
    );
  });
  it('retains the original body and key after an unknown outcome even when the server revision changes', async () => {
    installQueries();
    let current = unpausedWorkflowSettings;
    const requests: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.put(`${workflowApi}/auto-pause`, async ({ request }) => {
        requests.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        current = {
          ...current,
          thresholdOverride: 5,
          effectiveThreshold: 5,
          settingsRevision: 2,
        };
        if (requests.length === 1) return HttpResponse.error();
        return HttpResponse.json({ settings: current, replayed: true });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', {
      name: 'Automatic pause',
    });
    await openEditorFor(event, 'Pause after failures in a row');
    const threshold = await within(section).findByRole('textbox', {
      name: 'Pause after failures in a row',
    });
    await event.type(threshold, '5');
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await event.click(
      await within(section).findByRole('button', { name: 'Retry same change' }),
    );
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[1]?.body).toEqual({
      enabled: true,
      thresholdOverride: 5,
      expectedSettingsRevision: 1,
    });
  });
});
