import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderLoadedApp } from '../../../support/render-app';
import {
  identityHandlers,
  workspace,
  workspaceId,
} from '../../failure-notifications/destinations/fixture';

// The inbox opens for anyone who can read the workspace (the API checks the
// same). When it can't open, the page names that, not an unrelated right.
it('explains a closed inbox by the right it checks', async () => {
  mockServer.use(...identityHandlers({ ...workspace, capabilities: [] }));
  await renderLoadedApp(`/w/${workspaceId}/inbox`);
  expect(await screen.findByText('The inbox is unavailable')).toBeVisible();
  expect(screen.getByText(/can’t open the inbox\./u)).toBeVisible();
  expect(screen.queryByText(/get notified when workflows fail/u)).toBeNull();
});
