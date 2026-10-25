import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { mockServer } from '../../../../support/mock-server';
import { renderApp } from '../../../../support/render-app';
import {
  api,
  discoveryHandlers,
  draftHandler,
  organizedPage,
  summary,
  workflowId,
  workspaceId,
} from '../fixtures';
export function listHandler(
  pages: (after: string | null) => Record<string, unknown>,
) {
  return http.get(`${api}/workflows`, ({ request }) =>
    new URL(request.url).searchParams.has('pinsWorkflowId')
      ? HttpResponse.json({ items: [], nextCursor: null })
      : HttpResponse.json(
          organizedPage(
            pages(new URL(request.url).searchParams.get('after')) as never,
          ),
        ),
  );
}

export async function archiveAgainstProblem(problem: {
  code: string;
  title: string;
  extra?: Record<string, unknown>;
}) {
  const keys: (string | null)[] = [];
  mockServer.use(
    ...discoveryHandlers(['workflow:create', 'workflow:publish']),
    draftHandler(),
    listHandler(() => ({
      items: [summary(workflowId, 'Invoice intake', { lifecycleRevision: 4 })],
      nextCursor: null,
    })),
    http.post(`${api}/workflows/${workflowId}/archive`, ({ request }) => {
      keys.push(request.headers.get('idempotency-key'));
      return HttpResponse.json(
        {
          type: `urn:pertexo:problem:${problem.code}`,
          title: problem.title,
          status: 409,
          code: problem.code,
          requestId: 'archive-conflict',
          ...problem.extra,
        },
        {
          status: 409,
          headers: { 'content-type': 'application/problem+json' },
        },
      );
    }),
  );
  renderApp(`/w/${workspaceId}/workflows`);
  const event = userEvent.setup();
  await event.click(
    await screen.findByRole('button', { name: 'Actions for Invoice intake' }),
  );
  await event.click(await screen.findByRole('menuitem', { name: 'Archive…' }));
  const dialog = await screen.findByRole('dialog', {
    name: 'Archive this workflow?',
  });
  await event.click(within(dialog).getByRole('button', { name: 'Archive' }));
  return { dialog, event, keys };
}
