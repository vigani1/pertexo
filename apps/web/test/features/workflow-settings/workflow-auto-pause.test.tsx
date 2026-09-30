import { HttpResponse, http } from 'msw';
import { screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WorkflowAutoPauseSettings } from '@pertexo/contracts/schemas/workflow-authoring';
import { mockServer } from '../../support/mock-server';
import { unpausedWorkflowSettings } from '../../support/auto-pause-fixtures';
import { renderApp } from '../../support/render-app';
import {
  installQueries,
  workflowApi,
  workspaceId,
  workflowId,
} from './workflow-settings.fixtures';

const path = `/w/${workspaceId}/workflows/${workflowId}/settings`;
const paused: WorkflowAutoPauseSettings = {
  ...unpausedWorkflowSettings,
  pauseState: 'paused',
  pauseRevision: '9007199254740993',
  pausedAt: '2026-09-30T10:00:00Z',
  pauseReason: 'consecutive_failures',
  pausedFailures: 10,
  pausedLastRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

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
      'Current configured rule: 12 failures in a row.',
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
    expect(
      within(section).getByText(
        'Automatic pauses depend on enforcement being enabled for the deployment evaluator. Changing this rule does not enable it.',
      ),
    ).toBeVisible();
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

  it('keeps edits on typed conflict, refreshes authority and waits for explicit resubmission', async () => {
    installQueries();
    let current = unpausedWorkflowSettings;
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(current)),
      http.put(`${workflowApi}/auto-pause`, async ({ request }) => {
        bodies.push(await request.json());
        if (bodies.length === 1) {
          current = {
            ...current,
            thresholdOverride: 12,
            effectiveThreshold: 12,
            settingsRevision: 2,
          };
          return HttpResponse.json(
            {
              type: 'https://api.pertexo.test/problems/workflow.auto_pause_settings_conflict',
              title: 'Settings conflict',
              status: 409,
              code: 'workflow.auto_pause_settings_conflict',
              requestId: 'req-autopause',
              currentSettingsRevision: 2,
            },
            {
              status: 409,
              headers: { 'content-type': 'application/problem+json' },
            },
          );
        }
        current = {
          ...current,
          thresholdOverride: 6,
          effectiveThreshold: 6,
          settingsRevision: 3,
        };
        return HttpResponse.json({ settings: current, replayed: false });
      }),
    );
    renderApp(path);
    const event = userEvent.setup();
    const section = await screen.findByRole('region', {
      name: 'Automatic pause',
    });
    const threshold = await within(section).findByRole('textbox', {
      name: 'Pause after failures in a row',
    });
    await event.type(threshold, '6');
    await event.click(
      within(section).getByRole('button', { name: 'Save auto-pause rule' }),
    );
    await within(section).findByText(/Your edits are kept/u);
    expect(threshold).toHaveValue('6');
    expect(bodies).toHaveLength(1);
    await within(section).findByText(
      'Current configured rule: 12 failures in a row.',
    );
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

  it('does not offer Resume, rule edits or workspace defaults without their capabilities', async () => {
    installQueries([]);
    mockServer.use(
      http.get(`${workflowApi}/auto-pause`, () => HttpResponse.json(paused)),
    );
    renderApp(path);
    await screen.findByText('Schedules and webhooks are paused');
    expect(
      screen.queryByRole('button', { name: 'Resume triggers' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save auto-pause rule' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Save workspace default' }),
    ).not.toBeInTheDocument();
  });

  it('validates bounds and saves the owner-only workspace default', async () => {
    installQueries(['workflow:update', 'workspace:manage']);
    let current = { threshold: 10, revision: 1 };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/auto-pause`,
        () => HttpResponse.json(current),
      ),
      http.put(
        `http://pertexo.test/v1/workspaces/${workspaceId}/auto-pause`,
        async ({ request }) => {
          bodies.push(await request.json());
          current = { threshold: 15, revision: 2 };
          return HttpResponse.json({ settings: current, replayed: false });
        },
      ),
    );
    renderApp(path);
    const event = userEvent.setup();
    const input = await screen.findByRole('textbox', {
      name: 'Workspace default',
    });
    await event.clear(input);
    await event.type(input, '2');
    await event.click(
      screen.getByRole('button', { name: 'Save workspace default' }),
    );
    expect(
      await screen.findByText('Enter a whole number from 3 to 100.'),
    ).toBeVisible();
    expect(bodies).toHaveLength(0);
    await event.clear(input);
    await event.type(input, '15');
    await event.click(
      screen.getByRole('button', { name: 'Save workspace default' }),
    );
    await screen.findByText('Workspace auto-pause default saved');
    expect(bodies).toEqual([{ threshold: 15, expectedRevision: 1 }]);
  });
});
