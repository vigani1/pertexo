import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, describe, expect, it } from 'vitest';

import {
  apiBase,
  coldStart,
  fixtureRun,
} from '../../../../support/fixtures/run';

import { mockServer } from '../../../../support/mock-server';

import { renderApp } from '../../../../support/render-app';

import {
  artifactId,
  installRun,
  node,
  retryingRun,
  runId,
  secondsAgo,
  stepEvent,
  workspaceId,
} from './fixture';

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

describe('run page', () => {
  it('says in words when live updates pause and reconnects on request', async () => {
    const run = installRun({
      run: retryingRun(),
      nodes: [node('running')],
      stream: () =>
        HttpResponse.json(
          {
            type: 'urn:pertexo:problem:forbidden',
            title: 'Forbidden',
            status: 403,
            code: 'auth.forbidden',
            requestId: 'stream-forbidden',
          },
          {
            status: 403,
            headers: { 'content-type': 'application/problem+json' },
          },
        ),
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByText('Updates paused', undefined, coldStart),
    ).toBeVisible();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(run.streamCount()).toBe(2);
    });
  });
  it('shows the run input and a step’s file in its Data out', async () => {
    mockServer.use(
      http.get(`${apiBase}/artifacts/${artifactId}`, () =>
        HttpResponse.json({
          id: artifactId,
          workspaceId,
          byteLength: 2_048,
          mediaType: 'text/csv',
          sha256: 'a'.repeat(64),
          status: 'available',
          createdAt: '2026-09-14T10:00:00.000Z',
          expiresAt: null,
        }),
      ),
    );
    installRun({
      run: fixtureRun(runId, 'succeeded'),
      nodes: [node('succeeded', { completedAt: secondsAgo(1) })],
      events: [
        stepEvent('node.started', 3, { attemptNumber: 1 }),
        stepEvent('node.succeeded', 2, {
          attemptNumber: 1,
          outputRef: { kind: 'artifact', artifactId },
        }),
        { type: 'run.succeeded' },
      ],
      input: { kind: 'inline', value: { orderId: 'A-17' } },
      output: { kind: 'artifact', artifactId },
    });
    renderApp(`/w/${workspaceId}/runs/${runId}`);
    expect(
      await screen.findByRole(
        'heading',
        { level: 1, name: 'Succeeded in 2s' },
        coldStart,
      ),
    ).toBeVisible();

    // The only step's input came from the run's; with nothing recorded, it
    // shows as source data. It returned a file.
    const lens = screen.getByRole('complementary', { name: 'Step details' });
    const sources = await within(lens).findByRole('region', {
      name: 'Where it came from',
    });
    const runInput = await within(sources).findByRole('group', {
      name: 'Run input',
    });
    expect(await within(runInput).findByText(/A-17/u)).toBeVisible();
    expect(await within(lens).findByText('CSV file')).toBeVisible();

    await userEvent
      .setup()
      .click(screen.getByRole('tab', { name: 'Input & output' }));
    const panel = screen.getByRole('tabpanel');
    expect(
      await within(panel).findByRole('group', { name: 'Run input' }),
    ).toHaveTextContent(/orderId/u);
    expect(
      within(panel).getByRole('button', { name: /Send receipt/u }),
    ).toHaveTextContent('file');
  });
});
