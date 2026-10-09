import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';
import {
  editorHandlers,
  editorPath,
  findCanvas,
  graphWithMappingNodes,
  manualDefinition,
  mappingDefinition,
  identityHandler,
  user,
  otherUser,
  findPaused,
  workflowApi,
  workflowId,
  workspaceId,
} from '../../support/fixtures/workflow-editor';

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

async function testTarget(
  status: 'succeeded' | 'failed',
  numericScratch = false,
) {
  let saves = 0;
  mockServer.use(
    ...editorHandlers(
      () => {
        saves += 1;
      },
      {
        graph: graphWithMappingNodes(),
        definitions: [
          numericScratch
            ? {
                ...manualDefinition,
                configSchema: {
                  type: 'object',
                  properties: { count: { type: 'integer', title: 'Count' } },
                },
              }
            : manualDefinition,
          mappingDefinition,
        ],
      },
    ),
    http.post(`${workflowApi}/draft/nodes/target/test`, () =>
      HttpResponse.json(finishedTest(status), { status: 202 }),
    ),
  );
  const { queryClient } = renderApp(editorPath, { strict: true });
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
  return { event, canvas, bar: within(bar), queryClient, saves: () => saves };
}

describe('the last test bar', { timeout: 30_000 }, () => {
  it('keeps the current Setup and scratch until View output is accepted, including Stay and Discard', async () => {
    const { event, canvas, bar, saves } = await testTarget('succeeded', true);
    fireEvent.click(canvas.getByText('Manual input'));
    await event.click(screen.getByRole('tab', { name: 'Setup' }));
    const count = screen.getByLabelText('Count');
    fireEvent.change(count, { target: { value: '-' } });
    await event.click(bar.getByRole('button', { name: 'View output' }));
    expect(
      await screen.findByRole('dialog', {
        name: 'Discard the unfinished edit?',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('tab', { name: 'Setup', hidden: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await event.click(screen.getByRole('button', { name: 'Stay' }));
    expect(count).toBeVisible();
    expect(count).toHaveValue('-');
    expect(screen.getByLabelText('Label')).toHaveValue('Manual input');
    expect(saves()).toBe(0);
    await event.click(bar.getByRole('button', { name: 'View output' }));
    await event.click(
      await screen.findByRole('button', { name: 'Discard edit' }),
    );
    expect(screen.getByRole('tab', { name: 'Test' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Test result' })).toHaveFocus();
    });
    expect(screen.getByLabelText('Label')).toHaveValue('Target');
    expect(saves()).toBe(0);
  });

  it('does not discard scratch or navigate a pending View output action while identity is paused', async () => {
    const { event, canvas, bar, queryClient } = await testTarget(
      'succeeded',
      true,
    );
    let currentUser = user;
    mockServer.use(identityHandler(() => currentUser));
    fireEvent.click(canvas.getByText('Manual input'));
    await event.click(screen.getByRole('tab', { name: 'Setup' }));
    fireEvent.change(screen.getByLabelText('Count'), {
      target: { value: '-' },
    });
    await event.click(bar.getByRole('button', { name: 'View output' }));
    const discard = await screen.findByRole('button', { name: 'Discard edit' });
    currentUser = otherUser;
    await queryClient.refetchQueries({
      queryKey: ['identity', 'current-user'],
    });
    expect(await findPaused()).toBeVisible();
    await event.click(discard);
    currentUser = user;
    await event.click(
      screen.getByRole('button', { name: 'Verify original account' }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: 'Editor paused' }),
      ).toBeNull();
    });
    expect(
      screen.getByRole('tab', { name: 'Setup', hidden: true }),
    ).toHaveAttribute('aria-selected', 'true');
    await event.click(screen.getByRole('button', { name: 'Stay' }));
    expect(screen.getByLabelText('Label')).toHaveValue('Manual input');
    expect(screen.getByLabelText('Count')).toBeVisible();
    expect(screen.getByLabelText('Count')).toHaveValue('-');
  });

  it('sums up a passed test and opens its output on the step’s Test tab', async () => {
    const { event, canvas, bar } = await testTarget('succeeded');
    expect(bar.getByText('Test passed')).toBeVisible();
    expect(bar.getByTitle('Manual input → Target · 1.4s')).toBeVisible();

    // A jump within the inspected step is still intentional navigation.
    await event.click(screen.getByRole('tab', { name: 'Setup' }));
    await event.click(bar.getByRole('button', { name: 'View output' }));
    expect(
      screen.queryByRole('dialog', { name: 'Discard the unfinished edit?' }),
    ).toBeNull();
    expect(screen.getByRole('tab', { name: 'Test' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Test result' })).toHaveFocus(),
    );

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
      bar.getByTitle('Manual input → Target · 1.4s · service unavailable'),
    ).toBeVisible();
    expect(bar.getByRole('button', { name: 'View details' })).toBeVisible();
    expect(
      screen.getByText(/The step reported: service unavailable/u),
    ).toBeVisible();
  });
});
