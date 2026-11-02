import type { AccessibleWorkspace } from '@pertexo/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  apiBase,
  coldStart,
  fixtureIds,
  fixtureRun,
  identityHandlers,
  sseEvents,
  statisticsHandler,
} from '../../support/fixtures/run';
import { mockServer } from '../../support/mock-server';
import { renderApp } from '../../support/render-app';

const {
  workspace: workspaceId,
  firstRun: sourceRunId,
  replayRun: replayRunId,
  version: workflowVersionId,
} = fixtureIds;
const operator: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'run:replay',
];
const RUN_INPUT = { order: 'A-17' };
const RUN_INPUT_TEXT = JSON.stringify(RUN_INPUT, null, 2);
const LABEL = 'Replay input (JSON)';

/**
 * The run's input is read when the dialog opens, so a person can get there first.
 * Each response here is held until the test lets it go, so what happens while it's
 * away isn't down to timing.
 */
describe('Replay while the run’s input is still loading', () => {
  let inputAnswer: PromiseWithResolvers<undefined>;
  let replayAnswer: PromiseWithResolvers<undefined>;
  let inputAsked: PromiseWithResolvers<undefined>;
  let bodies: unknown[];

  const answerInput = () => {
    inputAnswer.resolve(undefined);
  };

  beforeEach(() => {
    inputAnswer = Promise.withResolvers();
    inputAsked = Promise.withResolvers();
    replayAnswer = Promise.withResolvers();
    // Only the tests about a replay in flight hold this one.
    replayAnswer.resolve(undefined);
    bodies = [];
    mockServer.use(
      ...identityHandlers(operator),
      statisticsHandler(),
      http.get(`${apiBase}/runs/:runId/input`, async () => {
        inputAsked.resolve(undefined);
        await inputAnswer.promise;
        return HttpResponse.json({
          input: { kind: 'inline', value: RUN_INPUT },
        });
      }),
      http.get(`${apiBase}/runs/:runId`, ({ params }) =>
        HttpResponse.json({
          run: fixtureRun(String(params.runId), 'failed', {
            workflowName: null,
          }),
          nodes: [],
        }),
      ),
      http.get(
        `${apiBase}/runs/:runId/events`,
        () =>
          new HttpResponse(sseEvents([{ type: 'run.failed' }]), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
      http.get(`${apiBase}/runs`, () =>
        HttpResponse.json({ items: [], nextCursor: null }),
      ),
      http.post(
        `${apiBase}/runs/${sourceRunId}/replay`,
        async ({ request }) => {
          bodies.push(await request.json());
          await replayAnswer.promise;
          const { workflowName: _name, ...run } = fixtureRun(
            replayRunId,
            'queued',
          );
          return HttpResponse.json({ run, replayed: false }, { status: 202 });
        },
      ),
    );
  });

  const openWhileLoading = async () => {
    const view = renderApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Replay' }, coldStart),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Replay this run',
    });
    await inputAsked.promise;
    return { ...view, event, dialog: within(dialog) };
  };

  const opened = (router: ReturnType<typeof renderApp>['router']) =>
    waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${replayRunId}`,
      );
    });

  const sent = (input: unknown) => ({ workflowVersionId, input });

  it('sends what was typed, with the input still on its way', async () => {
    const { event, dialog, router } = await openWhileLoading();
    const typed = '{"order":"B-2"}';

    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: typed },
    });
    expect(dialog.getByLabelText(LABEL)).toHaveValue(typed);
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));

    await opened(router);
    expect(bodies).toEqual([sent({ order: 'B-2' })]);
    answerInput();
  });

  it('keeps what was typed when the input arrives, and sends that', async () => {
    const { event, dialog, router, queryClient } = await openWhileLoading();
    const typed = '{"order":"B-2"}';
    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: typed },
    });

    answerInput();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });

    expect(dialog.getByLabelText(LABEL)).toHaveValue(typed);
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await opened(router);
    expect(bodies).toEqual([sent({ order: 'B-2' })]);
  });

  it('keeps what is being typed a keystroke at a time as the input arrives', async () => {
    const { event, dialog, queryClient } = await openWhileLoading();
    const field = dialog.getByLabelText(LABEL);
    await event.clear(field);
    await event.type(field, '12');

    answerInput();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    await event.type(field, '3');

    expect(field).toHaveValue('123');
  });

  // The request is on its way: an input turning up can't change it or stop it.
  it('finishes a replay already sent when the input arrives under it', async () => {
    replayAnswer = Promise.withResolvers();
    const { event, dialog, router, queryClient } = await openWhileLoading();
    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: '{"order":"B-2"}' },
    });
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    answerInput();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(dialog.getByLabelText(LABEL)).toHaveValue('{"order":"B-2"}');
    replayAnswer.resolve(undefined);

    await opened(router);
    expect(bodies).toEqual([sent({ order: 'B-2' })]);
  });

  it('fills a field nobody has typed in, and sends the run’s input', async () => {
    const { event, dialog, router } = await openWhileLoading();

    answerInput();

    await waitFor(() => {
      expect(dialog.getByLabelText(LABEL)).toHaveValue(RUN_INPUT_TEXT);
    });
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await opened(router);
    expect(bodies).toEqual([sent(RUN_INPUT)]);
  });

  // The dialog promises the run's own input. An untouched field reads {} only because
  // the answer hasn't come, and steps that call other services run again on it.
  it('doesn’t send an empty input for a field nobody has typed in', async () => {
    const { event, dialog, router } = await openWhileLoading();

    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    expect(bodies).toEqual([]);

    answerInput();
    await waitFor(() => {
      expect(dialog.getByLabelText(LABEL)).toHaveValue(RUN_INPUT_TEXT);
    });
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await opened(router);
    expect(bodies).toEqual([sent(RUN_INPUT)]);
  });
});
