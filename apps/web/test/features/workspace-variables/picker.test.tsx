import { HttpResponse, http } from 'msw';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { findCanvas } from '../../support/fixtures/editor-actions';
import { graphWithMappingNodes } from '../../support/fixtures/editor-graph';
import {
  editorHandlers,
  editorPath,
  manualDefinition,
  mappingDefinition,
  workspaceId,
} from '../../support/fixtures/workflow-editor';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const LOADING_MS = 15_000;

describe('the workspace variable picker', { timeout: 60_000 }, () => {
  it('offers each variable as $vars.NAME with its kind and description', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithMappingNodes(),
        definitions: [manualDefinition, mappingDefinition],
      }),
      http.get(
        `http://pertexo.test/v1/workspaces/${workspaceId}/variables`,
        () =>
          HttpResponse.json({
            revision: 2,
            values: { CURRENCY: 'EUR', RETRIES: 3, SANDBOX: true },
            descriptions: { CURRENCY: 'Invoice currency.' },
          }),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    fireEvent.click((await findCanvas()).getByText('Target'));
    // The step panel loads lazily, and this is the first test in its file to open it.
    await event.click(
      await screen.findByRole(
        'tab',
        { name: 'Inputs' },
        { timeout: LOADING_MS },
      ),
    );
    const inputs = within(screen.getByRole('region', { name: 'Inputs' }));
    await event.click(inputs.getByRole('button', { name: 'Insert data' }));
    const picker = within(
      await screen.findByRole(
        'dialog',
        { name: 'Insert data' },
        { timeout: LOADING_MS },
      ),
    );
    expect(picker.getByText('Workspace variables')).toBeVisible();
    expect(
      await picker.findByRole(
        'button',
        { name: /^\$vars\.CURRENCY\s*text$/u },
        { timeout: LOADING_MS },
      ),
    ).toHaveAccessibleDescription('Invoice currency.');
    expect(
      picker.getByRole('button', { name: /^\$vars\.RETRIES\s*number$/u }),
    ).toBeVisible();
    expect(
      picker.getByRole('button', { name: /^\$vars\.SANDBOX\s*true\/false$/u }),
    ).toBeVisible();
    expect(picker.getByText(/Captured when the run starts/u)).toBeVisible();
  });
});
