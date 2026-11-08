import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coldStart } from '../../../support/fixtures/run';
import { mockServer } from '../../../support/mock-server';
import { renderApp } from '../../../support/render-app';
import {
  connection,
  connectionHandler,
  destination,
  destinationId,
  destinationsOf,
  destinationsUrl,
  identityHandlers,
  problem,
  workspaceId,
} from './fixture';

const label = '#C0123456789 via Incident Slack';
const accepted = {
  connection,
  outcome: { ok: true, httpStatus: 200, errorCode: null },
};

async function sendTest(answer: () => Response | Promise<Response>) {
  const calls: string[] = [];
  mockServer.use(
    ...identityHandlers(),
    connectionHandler(),
    destinationsOf(() => [destination()]),
    http.post(`${destinationsUrl}/${destinationId}/test`, ({ request }) => {
      calls.push(request.headers.get('idempotency-key') ?? '');
      return answer();
    }),
  );
  renderApp(`/w/${workspaceId}/alerts`);
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole(
      'button',
      { name: `Send test to ${label}` },
      coldStart,
    ),
  );
  const dialog = await screen.findByRole('dialog');
  await event.click(within(dialog).getByRole('button', { name: 'Send test' }));
  return { calls, event };
}

describe('sending a test to an alert destination', () => {
  it('names what the service refused', async () => {
    await sendTest(() =>
      HttpResponse.json({
        connection,
        outcome: {
          ok: false,
          httpStatus: 401,
          errorCode: 'connection.credential_rejected',
        },
      }),
    );
    expect(
      await screen.findByText(
        /reject.*(credential|token)|(credential|token).*reject/iu,
      ),
    ).toBeVisible();
  });

  it('says the service accepted the message when it did', async () => {
    await sendTest(() => HttpResponse.json(accepted));
    expect(
      await screen.findByText('The service accepted the test message.'),
    ).toBeVisible();
  });

  it('says the failure was on Pertexo’s side when the server fails', async () => {
    await sendTest(() => problem(500, 'internal.unexpected'));
    expect(
      await screen.findByText(/Pertexo’s side|Pertexo couldn’t/u),
    ).toBeVisible();
    expect(
      screen.queryByText(/Delivery wasn’t confirmed/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Check the destination/u),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: `Check test result for ${label}`,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `Send test to ${label}` }),
    ).toBeEnabled();
  });

  it('checks a result it really can’t know without sending again', async () => {
    let attempts = 0;
    const { calls, event } = await sendTest(() => {
      attempts += 1;
      return attempts === 1
        ? HttpResponse.error()
        : HttpResponse.json(accepted);
    });
    await event.click(
      await screen.findByRole('button', {
        name: `Check test result for ${label}`,
      }),
    );
    expect(
      await screen.findByText('The service accepted the test message.'),
    ).toBeVisible();
    expect(new Set(calls).size).toBe(1);
  });
});

afterEach(() => vi.restoreAllMocks());
it('explains expired recovery and requires another send confirmation for a new attempt', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { calls, event } = await sendTest(() =>
    HttpResponse.json({
      connection,
      outcome: {
        ok: false,
        httpStatus: null,
        errorCode: 'connection.test.network_failed',
      },
    }),
  );
  await screen.findByRole('button', { name: `Check test result for ${label}` });
  now += 86_400_000;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const start = await screen.findByRole('button', {
    name: `Start a new attempt for ${label}`,
  });
  expect(screen.getByText(/retry window has ended/)).toBeVisible();
  expect(calls).toHaveLength(1);
  await event.click(start);
  expect(calls).toHaveLength(1);
  await event.click(
    within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Send test',
    }),
  );
  await screen.findByRole('button', { name: `Check test result for ${label}` });
  expect(calls).toHaveLength(2);
  expect(calls[1]).not.toBe(calls[0]);
});

it.each([
  [
    409,
    'connection.conflict',
    'Destination changed while the test was starting. Reload its latest version.',
  ],
  [
    403,
    'auth.forbidden',
    'Your role can’t test alert destinations. Ask a workspace owner or administrator.',
  ],
  [
    429,
    'request.rate_limited',
    'Too many requests. Wait before sending another test.',
  ],
] as const)(
  'explains an alert-test refusal (%i)',
  async (status, code, message) => {
    await sendTest(() =>
      HttpResponse.json(
        {
          type: `urn:pertexo:problem:${code}`,
          title: 'Test refused',
          status,
          code,
          detail: message,
          requestId: 'destination-refusal',
        },
        { status, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    expect(await screen.findByText(message)).toBeVisible();
    if (status === 409)
      expect(
        screen.getByRole('button', { name: 'Reload destination' }),
      ).toBeVisible();
    expect(
      screen.queryByText(/Review the destination and its connection/u),
    ).not.toBeInTheDocument();
  },
);

it('waits through the server cooldown before offering another alert test', async () => {
  const { event, calls } = await sendTest(() =>
    HttpResponse.json(
      {
        type: 'urn:pertexo:problem:request.rate_limited',
        title: 'Too many requests',
        status: 429,
        code: 'request.rate_limited',
        requestId: 'test-cooldown',
      },
      {
        status: 429,
        headers: {
          'content-type': 'application/problem+json',
          'retry-after': '2',
        },
      },
    ),
  );
  await screen.findByText(
    'Too many requests. Wait before sending another test.',
  );
  const send = await screen.findByRole('button', {
    name: `Send test to ${label}`,
  });
  expect(send).toBeDisabled();
  await event.click(send);
  expect(calls).toHaveLength(1);
  await vi.waitFor(() => expect(send).toBeEnabled(), { timeout: 5000 });
});
