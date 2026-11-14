import { HttpResponse, http } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import { focusManager } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import { renderLoadedApp } from '../../support/render-app';
import {
  installQueries,
  schedule,
  scheduleId,
  workflowApi,
  workflowId,
  workspaceId,
} from './fixtures';

// Turning a schedule on or off carries no revision. After an answer is
// lost, turning it off again must take effect if someone else has since
// turned it back on, and must replay the first send (not apply a second)
// while the page can't tell whether the first landed.
const triggersPath = `/w/${workspaceId}/workflows/${workflowId}/triggers`;
const disablePath = `${workflowApi}/triggers/${scheduleId}/schedule/disable`;

type Status = 'active' | 'disabled';

function mountSchedule(
  lostAnswer: (state: { status: Status }) => void,
  readAfterLoss: 'reads' | 'fails' = 'reads',
) {
  installQueries();
  const state: { status: Status; lost: boolean } = {
    status: 'active',
    lost: false,
  };
  const keys: (string | null)[] = [];
  const applied: (string | null)[] = [];
  const view = () => ({
    ...schedule,
    status: state.status,
    healthStatus: state.status === 'disabled' ? 'disabled' : 'healthy',
  });
  mockServer.use(
    http.get(`${workflowApi}/triggers/schedules`, () =>
      state.lost && readAfterLoss === 'fails'
        ? HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Unavailable',
              status: 503,
              code: 'internal.unavailable',
            },
            { status: 503 },
          )
        : HttpResponse.json({ items: [view()] }),
    ),
    http.post(disablePath, ({ request }) => {
      const key = request.headers.get('idempotency-key');
      keys.push(key);
      // The server's receipt: a key it has seen replays, never reapplies.
      const replayed = applied.includes(key);
      if (!replayed) {
        applied.push(key);
        state.status = 'disabled';
      }
      if (keys.length === 1) {
        state.lost = true;
        lostAnswer(state);
        return HttpResponse.error();
      }
      return HttpResponse.json({ trigger: view(), replayed });
    }),
  );
  return { state, keys, applied };
}

async function turnOff() {
  const user = userEvent.setup();
  const card = await screen.findByRole(
    'article',
    { name: 'Schedule: Nightly check' },
    { timeout: 5_000 },
  );
  const toggle = await within(card).findByRole('switch');
  await waitFor(() => {
    expect(toggle).toBeEnabled();
  });
  await user.click(toggle);
  const dialog = await screen.findByRole('dialog', {
    name: 'Turn off this schedule?',
  });
  await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
}

it('turns a schedule off again under a new key once someone else turned it back on', async () => {
  const { state, keys, applied } = mountSchedule((current) => {
    // The first turn-off lands; another admin turns it back on before the
    // page reads the schedule again.
    current.status = 'active';
  });
  await renderLoadedApp(triggersPath);
  await turnOff();
  await screen.findByText(/Saving it again is safe/u);
  await turnOff();
  await screen.findByText('Schedule turned off');
  expect(keys).toHaveLength(2);
  // A replay of the first key would report success with the schedule on.
  expect(keys[1]).not.toEqual(keys[0]);
  expect(applied).toHaveLength(2);
  expect(state.status).toBe('disabled');
});

it('replays the first turn-off, not a second, while the schedule can’t be read', async () => {
  const { state, keys, applied } = mountSchedule(() => undefined, 'fails');
  await renderLoadedApp(triggersPath);
  await turnOff();
  await screen.findByText(/Saving it again is safe/u);
  await turnOff();
  await screen.findByText('Schedule turned off');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toEqual(keys[0]);
  expect(applied).toHaveLength(1);
  expect(state.status).toBe('disabled');
});

it('keeps a lost turn-off’s key while another schedule is turned off', async () => {
  installQueries();
  const otherId = '22222222-2222-4222-8222-222222222222';
  const status: Record<string, Status> = {
    [scheduleId]: 'active',
    [otherId]: 'active',
  };
  let lost = false;
  const keysA: (string | null)[] = [];
  const appliedA: (string | null)[] = [];
  const view = (id: string) => ({
    ...schedule,
    id,
    status: status[id],
    healthStatus: status[id] === 'disabled' ? 'disabled' : 'healthy',
  });
  mockServer.use(
    http.get(`${workflowApi}/triggers/schedules`, () =>
      lost
        ? HttpResponse.json(
            {
              type: 'about:blank',
              title: 'Unavailable',
              status: 503,
              code: 'internal.unavailable',
            },
            { status: 503 },
          )
        : HttpResponse.json({ items: [view(scheduleId), view(otherId)] }),
    ),
    http.post(
      `${workflowApi}/triggers/:id/schedule/disable`,
      ({ request, params }) => {
        const id = String(params.id);
        const key = request.headers.get('idempotency-key');
        if (id !== scheduleId) {
          status[id] = 'disabled';
          return HttpResponse.json({ trigger: view(id), replayed: false });
        }
        keysA.push(key);
        const replayed = appliedA.includes(key);
        if (!replayed) {
          appliedA.push(key);
          status[id] = 'disabled';
        }
        if (keysA.length === 1) {
          // A's turn-off lands, its answer is lost, and reads fail after.
          lost = true;
          return HttpResponse.error();
        }
        return HttpResponse.json({ trigger: view(id), replayed });
      },
    ),
  );
  await renderLoadedApp(triggersPath);
  const user = userEvent.setup();
  const turnOffCard = async (index: number) => {
    const cards = await screen.findAllByRole(
      'article',
      { name: /^Schedule:/u },
      { timeout: 5_000 },
    );
    const card = cards[index];
    if (card === undefined) throw new Error(`No schedule ${String(index)}`);
    const toggle = within(card).getByRole('switch');
    await waitFor(() => {
      expect(toggle).toBeEnabled();
    });
    await user.click(toggle);
    const dialog = await screen.findByRole('dialog', {
      name: 'Turn off this schedule?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
  };
  await turnOffCard(0);
  await screen.findByText(/Saving it again is safe/u);
  await turnOffCard(1);
  await screen.findByText('Schedule turned off');
  await turnOffCard(0);
  await waitFor(() => {
    expect(keysA).toHaveLength(2);
  });
  expect(keysA[1]).toEqual(keysA[0]);
  expect(appliedA).toHaveLength(1);
});

it('turns it off under a new key once a later read shows it undone, after a failed one', async () => {
  const { state, keys } = mountSchedule(() => undefined, 'fails');
  await renderLoadedApp(triggersPath);
  await turnOff();
  await screen.findByText(/Saving it again is safe/u);
  // Another admin turns it back on; the person leaves the window and comes
  // back, and this time the read answers.
  state.status = 'active';
  state.lost = false;
  act(() => {
    focusManager.setFocused(false);
  });
  act(() => {
    focusManager.setFocused(true);
  });
  const card = await screen.findByRole('article', {
    name: 'Schedule: Nightly check',
  });
  await waitFor(() => {
    expect(within(card).getByRole('switch')).toBeChecked();
  });
  await turnOff();
  await screen.findByText('Schedule turned off');
  expect(keys).toHaveLength(2);
  // The page showed the schedule on, so this turn-off must apply, not
  // replay the old "turned off" receipt.
  expect(keys[1]).not.toEqual(keys[0]);
  expect(state.status).toBe('disabled');
});
