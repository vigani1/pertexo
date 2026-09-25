import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../support/mock-server';
import { renderApp } from '../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  workflowApi,
  workflowId,
  workspaceId,
} from '../support/workflow-editor-fixtures';

const disclosure = {
  sideEffectClass: 'safe',
  mayContactProvider: false,
  mayCauseExternalSideEffect: false,
  dryRun: 'not_supported',
} as const;

/** A finished test of `target` that took 1.4 seconds. */
function finishedTest(status: 'succeeded' | 'failed') {
  return {
    mode: 'test_execute',
    replayed: false,
    preview: {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      workspaceId,
      workflowId,
      draftRevision: 1,
      nodeId: 'target',
      status,
      disclosure,
      output:
        status === 'succeeded'
          ? { kind: 'inline', value: { accepted: true } }
          : null,
      safeErrorCode: status === 'succeeded' ? null : 'provider.unavailable',
      createdAt: '2026-09-14T10:00:00.000Z',
      startedAt: '2026-09-14T10:00:00.000Z',
      completedAt: '2026-09-14T10:00:01.400Z',
      expiresAt: '2026-09-15T10:00:00.000Z',
    },
  };
}

async function testTarget(status: 'succeeded' | 'failed') {
  mockServer.use(
    ...editorHandlers(() => undefined, {
      graph: graphWithMappingNodes(),
      definitions: [manualDefinition, mappingDefinition],
    }),
    http.post(`${workflowApi}/draft/nodes/target/test`, () =>
      HttpResponse.json(finishedTest(status), { status: 202 }),
    ),
  );
  renderApp(editorPath);
  const event = userEvent.setup();
  const canvas = await findCanvas();
  fireEvent.click(canvas.getByText('Target'));
  await event.click(screen.getByRole('tab', { name: 'Test' }));
  await event.click(
    screen.getByRole('switch', {
      name: 'I understand this test runs for real',
    }),
  );
  await event.click(screen.getByRole('button', { name: 'Run test' }));
  const bar = await screen.findByRole('region', { name: 'Last test' });
  return { event, canvas, bar: within(bar) };
}

describe('the last test bar', { timeout: 30_000 }, () => {
  it('sums up a passed test and opens its output on the step’s Test tab', async () => {
    const { event, canvas, bar } = await testTarget('succeeded');
    expect(bar.getByText('Test passed')).toBeVisible();
    expect(bar.getByText('Manual input → Target · 1.4s')).toBeVisible();

    fireEvent.click(canvas.getByText('Manual input'));
    await event.click(screen.getByRole('tab', { name: 'Setup' }));
    await event.click(bar.getByRole('button', { name: 'View output' }));
    expect(screen.getByRole('tab', { name: 'Test' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Test result' })).toHaveFocus();
    });
    expect(
      screen.getByRole('group', { name: 'Test output' }),
    ).toHaveTextContent('accepted');

    // The next edit to the draft puts the bar away.
    fireEvent.change(screen.getByLabelText('Label'), {
      target: { value: 'Renamed target' },
    });
    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Last test' })).toBeNull();
    });
  });

  it('says a test didn’t pass and why, from the test’s own answer', async () => {
    const { bar } = await testTarget('failed');
    expect(bar.getByText('Test failed')).toBeVisible();
    expect(
      bar.getByText('Manual input → Target · 1.4s · service unavailable'),
    ).toBeVisible();
    expect(bar.getByRole('button', { name: 'View details' })).toBeVisible();
    expect(
      screen.getByText(/The step reported: service unavailable/u),
    ).toBeVisible();
  });
});
