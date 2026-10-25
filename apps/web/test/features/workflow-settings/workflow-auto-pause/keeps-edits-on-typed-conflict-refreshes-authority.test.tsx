import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it } from 'vitest';

import { unpausedWorkflowSettings } from '../../../support/fixtures/auto-pause';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

import { installQueries, workflowApi, workspaceId } from '../fixtures';

import { openEditorFor, path, paused, sentence } from './fixture';

describe('workflow automatic pause controls', () => {
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
    await openEditorFor(event, 'Pause after failures in a row');
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
      sentence('Schedules and webhooks pause after 12 failures in a row'),
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
    await openEditorFor(event, 'Workspace default');
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
