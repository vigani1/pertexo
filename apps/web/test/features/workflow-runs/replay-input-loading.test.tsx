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
import { type renderApp, renderLoadedApp } from '../../support/render-app';

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

type Held = Readonly<{ promise: Promise<void>; release: () => void }>;

function held(): Held {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The run's input is read when the dialog opens, so a person can get there first.
 * Each response here is held until the test lets it go, so what happens while it's
 * away isn't down to timing.
 */
describe('Replay while the run’s input is still loading', () => {
  let inputAnswer: Held;
  let replayAnswer: Held;
  let inputAsked: Held;
  let bodies: unknown[];

  const answerInput = () => {
    inputAnswer.release();
  };

  beforeEach(() => {
    inputAnswer = held();
    inputAsked = held();
    replayAnswer = held();
    // Only the tests about a replay in flight hold this one.
    replayAnswer.release();
    bodies = [];
    mockServer.use(
      ...identityHandlers(operator),
      statisticsHandler(),
      http.get(`${apiBase}/runs/:runId/input`, async () => {
        inputAsked.release();
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

  const openReplay = async () => {
    const view = await renderLoadedApp(`/w/${workspaceId}/runs/${sourceRunId}`);
    const event = userEvent.setup();
    await event.click(
      await screen.findByRole('button', { name: 'Replay' }, coldStart),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Replay this run',
    });
    return { ...view, event, dialog: within(dialog) };
  };

  const openWhileLoading = async () => {
    const opened = await openReplay();
    await inputAsked.promise;
    return opened;
  };

  const opened = (router: ReturnType<typeof renderApp>['router']) =>
    waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/w/${workspaceId}/runs/${replayRunId}`,
      );
    });

  const sent = (input: unknown) => ({ workflowVersionId, input });

  it('waits for the saved input before editing and sends its replacement', async () => {
    const { event, dialog, router } = await openWhileLoading();
    const typed = '{"order":"B-2"}';
    const field = dialog.getByLabelText(LABEL);
    expect(field).toBeDisabled();
    await event.type(field, 'must not enter');
    expect(field).toHaveValue('{}');
    answerInput();
    await waitFor(() => {
      expect(field).toBeEnabled();
    });

    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: typed },
    });
    expect(dialog.getByLabelText(LABEL)).toHaveValue(typed);
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));

    await opened(router);
    expect(bodies).toEqual([sent({ order: 'B-2' })]);
    answerInput();
  });

  it('keeps what was typed after the input arrives, and sends that', async () => {
    const { event, dialog, router, queryClient } = await openWhileLoading();
    const typed = '{"order":"B-2"}';

    answerInput();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: typed },
    });

    expect(dialog.getByLabelText(LABEL)).toHaveValue(typed);
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await opened(router);
    expect(bodies).toEqual([sent({ order: 'B-2' })]);
  });

  it('keeps keystroke edits after the saved input has loaded', async () => {
    const { event, dialog, queryClient } = await openWhileLoading();
    const field = dialog.getByLabelText(LABEL);
    expect(field).toBeDisabled();
    answerInput();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    await event.clear(field);
    await event.type(field, '12');
    await event.type(field, '3');

    expect(field).toHaveValue('123');
  });

  // Once submission starts, editing stays disabled until acceptance.
  it('finishes a replay sent after input loading with editing disabled', async () => {
    replayAnswer = held();
    const { event, dialog, router, queryClient } = await openWhileLoading();
    answerInput();
    await waitFor(() => {
      expect(dialog.getByLabelText(LABEL)).toBeEnabled();
    });
    fireEvent.change(dialog.getByLabelText(LABEL), {
      target: { value: '{"order":"B-2"}' },
    });
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await waitFor(() => {
      expect(bodies).toHaveLength(1);
    });

    expect(dialog.getByLabelText(LABEL)).toBeDisabled();
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(dialog.getByLabelText(LABEL)).toHaveValue('{"order":"B-2"}');
    replayAnswer.release();

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

  it.each([
    ['refused', 403],
    ['broken', 500],
  ])(
    'requires a successful saved-input retry after the read has %s',
    async (_name, status) => {
      mockServer.use(
        http.get(`${apiBase}/runs/:runId/input`, () =>
          HttpResponse.json(
            { type: 'about:blank', title: 'No', status },
            { status },
          ),
        ),
      );
      const { event, dialog, router } = await openReplay();

      const retry = await dialog.findByRole('button', {
        name: 'Retry saved input',
      });
      expect(dialog.getByRole('button', { name: 'Replay run' })).toBeDisabled();
      expect(bodies).toEqual([]);
      mockServer.use(
        http.get(`${apiBase}/runs/:runId/input`, () =>
          HttpResponse.json({ input: { kind: 'inline', value: RUN_INPUT } }),
        ),
      );
      await event.click(retry);
      await waitFor(() =>
        expect(dialog.getByLabelText(LABEL)).toHaveValue(RUN_INPUT_TEXT),
      );
      await event.click(dialog.getByRole('button', { name: 'Replay run' }));

      await opened(router);
      expect(bodies).toEqual([sent(RUN_INPUT)]);
    },
    30_000,
  );
  it('keeps replay blocked through a second failed saved-input recovery before sending the recovered input', async () => {
    let reads = 0;
    mockServer.use(
      http.get(`${apiBase}/runs/:runId/input`, () => {
        reads++;
        return reads < 3
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ input: { kind: 'inline', value: RUN_INPUT } });
      }),
    );
    const { event, dialog, router } = await openReplay();
    await event.click(
      await dialog.findByRole('button', { name: 'Retry saved input' }),
    );
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    const retry = await dialog.findByRole('button', {
      name: 'Retry saved input',
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(dialog.getByRole('button', { name: 'Replay run' })).toBeDisabled();
    expect(dialog.getByLabelText(LABEL)).toBeDisabled();
    expect(bodies).toEqual([]);
    await event.click(retry);
    await waitFor(() =>
      expect(dialog.getByLabelText(LABEL)).toHaveValue(RUN_INPUT_TEXT),
    );
    await event.click(dialog.getByRole('button', { name: 'Replay run' }));
    await opened(router);
    expect(bodies).toEqual([sent(RUN_INPUT)]);
  });
});
