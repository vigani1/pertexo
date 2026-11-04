import { HttpResponse, http } from 'msw';
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  installQueries,
  schedule,
  webhook,
  workflowApi,
  workflowId,
  workspaceId,
} from './fixtures';

it.each([
  ['schedule.recurrence_invalid', /edit the schedule and publish again/i],
  ['schedule.execution_incompatible', /publish it again/i],
])(
  'explains how to repair %s on the real schedule card',
  async (code, repair) => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/triggers/schedules`, () =>
        HttpResponse.json({
          items: [
            {
              ...schedule,
              recurrence:
                code === 'schedule.recurrence_invalid'
                  ? null
                  : schedule.recurrence,
              healthStatus: 'unhealthy',
              lastErrorCode: code,
            },
          ],
        }),
      ),
    );
    renderApp(`/w/${workspaceId}/workflows/${workflowId}/triggers`);
    const card = await screen.findByRole('article', {
      name: 'Schedule: Nightly check',
    });
    expect(await within(card).findByText(repair)).toBeVisible();
    expect(
      within(card).queryByText(/try again on its own/i),
    ).not.toBeInTheDocument();
  },
);
it('explains a malformed published webhook configuration without showing a raw error', async () => {
  installQueries();
  mockServer.use(
    http.get(`${workflowApi}/triggers`, () =>
      HttpResponse.json({
        items: [
          {
            ...webhook,
            status: 'error',
            healthStatus: 'unhealthy',
            lastErrorCode: 'trigger.configuration_invalid',
          },
        ],
      }),
    ),
  );
  renderApp(`/w/${workspaceId}/workflows/${workflowId}/triggers`);
  const card = await screen.findByRole('article', { name: /Webhook:/ });
  expect(
    await within(card).findByText(
      /review the trigger settings and publish again/i,
    ),
  ).toBeVisible();
});
