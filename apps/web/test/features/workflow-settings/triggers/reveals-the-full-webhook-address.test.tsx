import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { coldStart } from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import { installQueries, webhook, webhookId, workflowApi } from '../fixtures';
import { triggersPath } from './fixture';

const endpointKey = 'e'.repeat(43);
// The test environment serves the app from this origin, and /hooks is on the app's host.
const fullAddress = `http://localhost:3000/hooks/${endpointKey}`;

async function createEndpoint(
  credentials: Readonly<{ signingSecret?: string }>,
  authentication: unknown,
) {
  installQueries();
  mockServer.use(
    http.post(`${workflowApi}/triggers/${webhookId}/webhook/provision`, () =>
      HttpResponse.json({
        trigger: {
          ...webhook,
          endpointReady: true,
          status: 'active',
          authentication,
        },
        replayed: false,
        endpointKey,
        ...credentials,
      }),
    ),
  );
  renderApp(triggersPath);
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Create endpoint' }, coldStart),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Store these now',
  });
  return { dialog, event };
}

describe('the webhook address where the endpoint is created', () => {
  it('shows the whole address and copies it', async () => {
    const { dialog, event } = await createEndpoint(
      { signingSecret: 's'.repeat(43) },
      { mode: 'signed', allowedOrigins: [] },
    );
    expect(within(dialog).getByText(fullAddress)).toBeVisible();
    expect(dialog).not.toHaveTextContent('your Pertexo API address');
    expect(dialog).not.toHaveTextContent('can’t show the full address');
    await event.click(
      within(dialog).getByRole('button', {
        name: /copy (the )?(webhook )?(url|address)/iu,
      }),
    );
    expect(await navigator.clipboard.readText()).toBe(fullAddress);
  });

  it('shows the whole address for a secret URL with no secret beside it', async () => {
    const { dialog } = await createEndpoint(
      {},
      { mode: 'secret_url', allowedOrigins: [] },
    );
    expect(within(dialog).getByText(fullAddress)).toBeVisible();
  });
});
