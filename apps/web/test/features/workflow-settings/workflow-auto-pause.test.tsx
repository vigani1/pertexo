import type { WorkflowAutoPauseSettings } from '@pertexo/contracts';

import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { unpausedWorkflowSettings } from '../../support/fixtures/auto-pause';

import { mockServer } from '../../support/mock-server';

import { renderLoadedApp } from '../../support/render-app';

import { installQueries, workflowApi } from './fixtures';

import {
  openEditorFor,
  path,
  paused,
  sentence,
} from './workflow-auto-pause/fixture';

describe('workflow automatic pause controls', () => {
  it('keeps edited values and uses the reviewed current revision after a refused change', async () => {
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
    await renderLoadedApp(path);
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
      expectedSettingsRevision: 2,
    });
  });
  it('refreshes malformed 409 replies without claiming a revision conflict and lets people confirm a new change', async () => {
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
    await renderLoadedApp(path);
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
      await within(section).findByText(/We couldn’t confirm that change/u),
    ).toBeVisible();
    expect(
      within(section).queryByText(/Your edits are kept/u),
    ).not.toBeInTheDocument();
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await screen.findByText('Auto-pause settings saved');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.key).not.toBe(requests[1]?.key);
    expect(requests[1]?.body).toEqual({
      enabled: true,
      thresholdOverride: 5,
      expectedSettingsRevision: 2,
    });
  });
  it('shows the refreshed unpaused state after an unconfirmed Resume without sending another command', async () => {
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
    await renderLoadedApp(path);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Resume triggers' }),
    );
    await screen.findByText(/Check the refreshed current state/u);
    expect(
      screen.queryByRole('button', { name: 'Resume triggers' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Retry Resume' }),
    ).not.toBeInTheDocument();
    expect(requests).toHaveLength(1);
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
    await renderLoadedApp(path);
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
  it('labels and links pause evidence accurately for both historical and current rows', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(paused)),
    );
    await renderLoadedApp(path);
    const link = await screen.findByRole('link', {
      name: /^Run that triggered the pause$/u,
    });
    expect(link).toHaveAttribute(
      'href',
      expect.stringContaining(`/runs/${String(paused.pausedLastRunId)}`),
    );
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
    await renderLoadedApp(path);
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
  it('keeps edited values after an unknown outcome and confirms them at the refreshed revision with a fresh key', async () => {
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
    await renderLoadedApp(path);
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
      await within(section).findByRole('button', {
        name: 'Save auto-pause rule',
      }),
    );
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[0]?.key).not.toBe(requests[1]?.key);
    expect(requests[1]?.body).toEqual({
      enabled: true,
      thresholdOverride: 5,
      expectedSettingsRevision: 2,
    });
  });
});
