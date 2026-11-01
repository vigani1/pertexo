import type { WorkspaceVariableUsageResponse } from '@pertexo/contracts';
import { onlineManager } from '@tanstack/react-query';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { afterEach, expect } from 'vitest';
import { mockServer } from '../../../support/mock-server';
import { renderInRouter } from '../../../support/render-in-router';
import { DialogOpener, workspaceId } from './dialog-opener';

const endpoint = `http://pertexo.test/v1/workspaces/${workspaceId}/variables/usage`;

type UsageRow = WorkspaceVariableUsageResponse['items'][number];

/** A page of the check; `first` is the page asked for without a cursor. */
export function usagePage(
  counts: Readonly<{ checked: number; total: number }>,
  rest: Readonly<{
    next?: string;
    items?: readonly UsageRow[];
    incomplete?: boolean;
  }> = {},
): () => Response {
  return () =>
    HttpResponse.json({
      items: rest.items ?? [],
      nextCursor: rest.next ?? null,
      incomplete: rest.incomplete ?? false,
      checkedWorkflows: counts.checked,
      totalWorkflows: counts.total,
    });
}

export function reference(workflowName: string): UsageRow {
  return {
    id: workflowName.charCodeAt(0).toString(16).padStart(2, '0').repeat(32),
    workflowId: `dddddddd-dddd-4ddd-8ddd-${String(workflowName.length).padStart(12, '0')}`,
    workflowName,
    archived: false,
    stage: 'draft',
    nodeId: 'step',
    label: 'Set currency',
    input: 'currency',
    kind: 'direct',
  };
}

function problem(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): () => Response {
  return () =>
    HttpResponse.json(
      {
        type: 'about:blank',
        title: 'Refused',
        status,
        code,
        requestId: 'abcdef12-3456',
      },
      {
        status,
        headers: { 'content-type': 'application/problem+json', ...headers },
      },
    );
}

export const onOurSide = problem(500, 'internal.unexpected');
export const rateLimited = problem(429, 'request.rate_limited', {
  'retry-after': '7',
});
export const workflowChanged = problem(409, 'variables.usage_changed');
export const accessLost = problem(403, 'auth.forbidden');
export const connectionLost = () => HttpResponse.error();

/** A reply the test lets go of, to look at the screen while it's in flight. */
export function held(reply: () => Response) {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    reply: async () => {
      await released;
      return reply();
    },
  };
}

/**
 * The API's side of the check: each cursor answers with its replies in turn, and
 * asking for a page the test didn't plan fails. `asked` is every cursor requested,
 * with `null` for the first page.
 */
export function serveUsage(
  replies: Readonly<
    Record<string, readonly (() => Response | Promise<Response>)[]>
  >,
) {
  const asked: (string | null)[] = [];
  const pageSizes: (string | null)[] = [];
  const signals: AbortSignal[] = [];
  const left = new Map(
    Object.entries(replies).map(([cursor, list]) => [cursor, [...list]]),
  );
  mockServer.use(
    http.get(endpoint, ({ request }) => {
      const url = new URL(request.url);
      const after = url.searchParams.get('after');
      asked.push(after);
      pageSizes.push(url.searchParams.get('limit'));
      signals.push(request.signal);
      const reply = left.get(after ?? 'first')?.shift();
      if (reply === undefined)
        return problem(500, `test.unplanned_${String(after)}`)();
      return reply();
    }),
  );
  return { asked, pageSizes, signals };
}

/** Shows the page behind the dialog, so a test can lose the network first. */
export async function renderOpener(options: { onRemove?: () => void } = {}) {
  const event = userEvent.setup();
  const { queryClient } = renderInRouter(<DialogOpener {...options} />);
  await screen.findByRole('button', { name: 'Find references' });
  return {
    event,
    queryClient,
    open: () =>
      event.click(screen.getByRole('button', { name: 'Find references' })),
  };
}

export async function openDialog(options: { onRemove?: () => void } = {}) {
  const opened = await renderOpener(options);
  await opened.open();
  return opened.event;
}

export const removeOff = () =>
  screen.getByRole('button', { name: 'Remove from draft' });
export const removeAnyway = () =>
  screen.getByRole('button', { name: 'Remove anyway' });
export const REMOVE_HINT = 'You can remove this name when the check finishes.';
export const FAILED_WARNING =
  'This check didn’t finish, so workflows it didn’t reach may still use this name. New runs that require it will fail; existing snapshots stay unchanged.';
export const USUAL_WARNING =
  'Removing a name does not rewrite these references. New runs that require it will fail; existing snapshots stay unchanged.';

export function expectBar(now: number, max: number) {
  const bar = screen.getByRole('progressbar', { name: 'Workflows checked' });
  expect(bar).toHaveAttribute('aria-valuenow', String(now));
  expect(bar).toHaveAttribute('aria-valuemax', String(max));
  return bar;
}

export const barWidth = () =>
  (
    screen.getByRole('progressbar', { name: 'Workflows checked' })
      .firstElementChild as HTMLElement
  ).style.width;

/** The browser's own signals, which is what the query library listens to. */
export const goOffline = () => {
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
};
export const goOnline = () => {
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
};

/**
 * Long enough for a request the app wrongly sends to reach the mock server. Every
 * test using this proves the same gap catches a real request, in its own break.
 */
export const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

afterEach(() => {
  onlineManager.setOnline(true);
});
