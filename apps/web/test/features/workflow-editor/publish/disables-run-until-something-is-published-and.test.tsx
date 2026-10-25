import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addStepButton,
  checkNow,
  findCanvas,
  openRunLens,
} from '../../../support/fixtures/editor-actions';
import {
  graphWithMappingNodes,
  graphWithNumericConfig,
} from '../../../support/fixtures/editor-graph';
import {
  compatibility,
  editorHandlers,
  editorPath,
  etagA,
  manualDefinition,
  mappingDefinition,
  numericDefinition,
  publishedWorkflowHandlers,
  setDefinition,
  validHandler,
  workflowApi,
  workflowSummaryHandler,
} from '../../../support/fixtures/workflow-editor';

import { mockServer } from '../../../support/mock-server';

import { renderApp } from '../../../support/render-app';

afterEach(() => vi.useRealTimers());

describe('workflow editor publishing', { timeout: 30_000 }, () => {
  it('disables Run until something is published and Publish until the draft has a step', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        definitions: [manualDefinition, setDefinition],
      }),
    );
    mockServer.use(validHandler(), workflowSummaryHandler('Draft only', null));
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await screen.findByRole('heading', { name: 'Draft only' });
    expect(
      await screen.findByRole('button', { name: 'Run (publish first)' }),
    ).toHaveAttribute('aria-disabled', 'true');
    const publish = screen.getByRole('button', { name: 'Publish v1' });
    expect(publish).toHaveAttribute('aria-disabled', 'true');
    expect(publish).toHaveAccessibleDescription('Add a trigger to start');
    expect(
      await screen.findByRole('button', { name: 'Add a trigger to start' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'No issues' })).toBeNull();

    await event.click(
      within(screen.getByRole('list', { name: 'Triggers' })).getByRole(
        'button',
        { name: /Manual start/u },
      ),
    );
    expect(screen.getByRole('button', { name: 'Publish v1' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: 'Add a trigger to start' }),
    ).toBeNull();
  });
});

describe('workflow editor issues and checks', { timeout: 30_000 }, () => {
  it('groups issues by step and Fix opens the right field', async () => {
    const nodeId = '11111111-1111-4111-8111-111111111111';
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: graphWithNumericConfig({ requiredCount: 1 }),
        definitions: [numericDefinition],
      }),
    );
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json(
          {
            valid: false,
            currentPublication: null,
            issues: [
              {
                path: `$.nodes.${nodeId}.config.count`,
                code: 'invalid_config',
                message: 'count is required for this node',
              },
              {
                path: '$',
                code: 'invalid_graph',
                message: 'The workflow also has a general issue.',
              },
            ],
            compatibility,
          },
          { headers: { etag: etagA } },
        ),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await checkNow(event);
    expect(
      await screen.findByText('Count is required for this node.'),
    ).toBeVisible();
    expect(
      screen.getByText('The workflow also has a general issue.'),
    ).toBeVisible();
    expect(screen.getByText('Whole workflow')).toBeVisible();
    // The chip opens the issues lens at the bottom, not a popover.
    const lens = screen.getByRole('region', { name: /\d+ issues?/u });
    expect(
      within(lens).getByText('Review these before publishing or running.'),
    ).toBeVisible();
    await event.click(
      screen.getByRole('button', {
        name: 'Fix: Count is required for this node.',
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Count')).toHaveFocus();
    });
    expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('region', { name: /\d+ issues?/u })).toBeNull();
    const chip = screen.getByRole('button', { name: /\d+ issues?/u });
    expect(chip).toBeVisible();
    await event.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    await event.click(screen.getByRole('button', { name: 'Close issues' }));
    expect(screen.queryByRole('region', { name: /\d+ issues?/u })).toBeNull();
    expect(chip).toHaveFocus();
  });
  it('navigates compatibility and mapping findings to their step', async () => {
    mockServer.use(
      ...editorHandlers(() => undefined, {
        graph: {
          ...graphWithMappingNodes({
            customer: {
              kind: 'node_output',
              nodeId: 'manual',
              path: '$.customer',
            },
          }),
          nodes: [
            ...graphWithMappingNodes({
              customer: {
                kind: 'node_output',
                nodeId: 'manual',
                path: '$.customer',
              },
            }).nodes,
            {
              id: 'node-unsupported',
              definition: { key: 'core.retired', version: 7 },
              position: { x: 80, y: 280 },
              configVersion: 1,
              config: { unknown: { preserved: true } },
              inputMappings: {},
              connectionRefs: {},
            },
          ],
        },
        definitions: [manualDefinition, mappingDefinition],
      }),
    );
    mockServer.use(
      http.post(`${workflowApi}/validate`, () =>
        HttpResponse.json(
          {
            valid: false,
            currentPublication: null,
            issues: [
              {
                path: '$.nodes.target.inputMappings.customer',
                code: 'invalid_mapping',
                message:
                  'node output mappings must reference a direct local predecessor',
              },
            ],
            compatibility: {
              compatible: false,
              fingerprint: compatibility.fingerprint,
              issues: [
                {
                  code: 'unknown_definition',
                  definitionKey: 'core.retired',
                  version: 7,
                },
              ],
            },
          },
          { headers: { etag: etagA } },
        ),
      ),
    );
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await checkNow(event);
    await event.click(
      await screen.findByRole('button', {
        name: /Fix: This step’s type isn’t in the catalog/u,
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Label')).toHaveFocus();
    });
    expect(screen.getByLabelText('Setup as JSON')).toBeVisible();

    await event.click(screen.getByRole('button', { name: /\d+ issues?/u }));
    await event.click(
      await screen.findByRole('button', {
        name: /Fix: An input reads from a step/u,
      }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Field')).toHaveFocus();
    });
    expect(screen.getByLabelText('Field')).toHaveValue('customer');
  });
  it('checks the saved draft automatically once editing pauses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let validations = 0;
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(
      validHandler(() => {
        validations += 1;
      }),
    );
    renderApp(editorPath);
    const event = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await findCanvas();
    await event.click(addStepButton(/Set fields/u));
    await waitFor(
      () => {
        expect(validations).toBe(1);
      },
      { timeout: 6_000 },
    );
    expect(
      await screen.findByRole('button', { name: '1 issue' }),
    ).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_800));
    expect(validations).toBe(1);
  });
});

describe('workflow editor run lens', { timeout: 30_000 }, () => {
  it('associates run-start validation with the input and focuses it', async () => {
    mockServer.use(...editorHandlers(() => undefined));
    mockServer.use(...publishedWorkflowHandlers());
    renderApp(editorPath);
    const event = userEvent.setup();
    await findCanvas();
    await openRunLens(event);
    const input = screen.getByLabelText('Run input (JSON)');
    fireEvent.change(input, { target: { value: '{' } });
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/isn’t valid JSON/u);
    fireEvent.change(input, { target: { value: '{}' } });
    expect(input).toHaveAttribute('aria-invalid', 'false');

    // The deadline uses Weft's control, never the browser's picker.
    const deadline = screen.getByRole('group', { name: 'Deadline (optional)' });
    expect(deadline).toHaveTextContent(
      'A configured workflow duration limit may still stop the run.',
    );
    await event.click(
      within(deadline).getByRole('button', { name: 'In 1 hour' }),
    );
    expect(deadline).toHaveTextContent(
      /The run stops at .+ if it isn’t finished/u,
    );
    await event.click(
      within(deadline).getByRole('button', { name: 'Pick a time' }),
    );
    const date = within(deadline).getByLabelText('Deadline date');
    await event.clear(date);
    await event.click(
      screen.getByRole('button', { name: 'Start published version' }),
    );
    expect(date).toHaveFocus();
    expect(date).toHaveAccessibleDescription(/Enter the deadline as a date/u);
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull();
  });
});
