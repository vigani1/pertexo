import { screen, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { coldStart } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  draftResponse,
  emptyGraph,
  etag,
  installQueries,
  workflowApi,
  workflowId,
  workspaceId,
} from './fixtures';

const settingsPath = `/w/${workspaceId}/workflows/${workflowId}/settings`;

describe('workflow settings: run duration with no setting', () => {
  // backend-gaps-18: the page says 1 hour, while acceptance stores no deadline at all.
  it('says such a workflow has no time limit', async () => {
    installQueries();
    mockServer.use(
      http.get(`${workflowApi}/draft`, () => draftResponse(emptyGraph, etag)),
    );
    renderApp(settingsPath);
    const section = await screen.findByRole(
      'region',
      { name: 'Run duration' },
      coldStart,
    );
    const choice = await within(section).findByRole('combobox', {
      name: 'Maximum run duration',
    });
    expect(choice).toHaveTextContent(/no (?:time )?limit/iu);
    expect(section).not.toHaveTextContent('1 hour');
  });
});
