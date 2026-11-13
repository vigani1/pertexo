import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { coldStart, identityHandlers } from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  readerCapabilities,
  runHandlers,
  workflowHandlers,
  workspaceId,
} from '../overview/page/fixture';

// product-ux-12: help is one tap from every workspace page.
it('opens the public guides from Help on the spine, each in a new tab', async () => {
  mockServer.use(
    ...identityHandlers(readerCapabilities),
    workflowHandlers(),
    ...runHandlers(),
  );
  await renderLoadedApp(`/w/${workspaceId}`);
  // The spine and the phone bar are both workspace navigation; Help on the
  // spine is the menu button.
  await screen.findAllByRole('navigation', { name: 'Workspace' }, coldStart);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Help' }));
  const links = await screen.findAllByRole('menuitem');
  expect(
    links.map((link) => [link.textContent, link.getAttribute('href')]),
  ).toEqual([
    [
      'Your first workflow (opens in a new tab)',
      'https://github.com/vigani1/pertexo/blob/main/docs/guides/getting-started.md',
    ],
    [
      'All guides (opens in a new tab)',
      'https://github.com/vigani1/pertexo/blob/main/docs/guides/README.md',
    ],
    [
      'Glossary (opens in a new tab)',
      'https://github.com/vigani1/pertexo/blob/main/CONTEXT.md#core-terms',
    ],
  ]);
  for (const link of links) expect(link).toHaveAttribute('target', '_blank');
});
