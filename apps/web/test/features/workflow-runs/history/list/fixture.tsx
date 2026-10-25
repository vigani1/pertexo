import type { AccessibleWorkspace } from '@pertexo/contracts';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import {
  apiBase,
  fixtureIds,
  fixtureRun,
  fixtureWorkflow,
  statisticsHandler,
} from '../../../../support/fixtures/run';
export const { workspace: workspaceId, workflow: workflowId } = fixtureIds;

export const { firstRun: firstRunId, secondRun: secondRunId } = fixtureIds;

export const readerCapabilities: AccessibleWorkspace['capabilities'] = [
  'workspace:read',
  'run:read',
  'workflow:read',
];

export function workflowReads() {
  return [
    http.get(`${apiBase}/workflows`, () =>
      HttpResponse.json({ items: [fixtureWorkflow()], nextCursor: null }),
    ),
    http.get(`${apiBase}/workflows/${workflowId}`, () =>
      HttpResponse.json({ workflow: fixtureWorkflow() }),
    ),
  ];
}

export function historyReads(requests: URLSearchParams[] = []) {
  const history = http.get(`${apiBase}/runs`, ({ request }) => {
    const query = new URL(request.url).searchParams;
    requests.push(query);
    return HttpResponse.json(
      query.get('after') === null
        ? { items: [fixtureRun(firstRunId, 'succeeded')], nextCursor: 'next' }
        : {
            items: [
              fixtureRun(secondRunId, 'failed', { triggerType: 'webhook' }),
            ],
            nextCursor: null,
          },
    );
  });
  return [history, statisticsHandler()];
}

export function latest(requests: readonly URLSearchParams[]) {
  return requests.at(-1) ?? new URLSearchParams();
}

export async function chooseOption(label: string, option: string) {
  const event = userEvent.setup();
  await event.click(screen.getByRole('combobox', { name: label }));
  await event.click(await screen.findByRole('option', { name: option }));
}
