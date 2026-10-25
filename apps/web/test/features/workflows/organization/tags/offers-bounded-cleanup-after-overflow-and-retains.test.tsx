import { screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../../../support/mock-server';

import {
  api,
  problem,
  secondWorkflowId,
  summary,
  workflowId,
} from '../../list/fixtures';

import { cursor, installVocabulary, renderTags } from './fixture';

describe('workflow tags dialog', () => {
  it('offers bounded cleanup after overflow and retains exact ordered selection on retry', async () => {
    installVocabulary();
    const assignmentReads = vi.fn();
    const sent: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(`${api}/workflow-tags/${secondWorkflowId}/delete`, () =>
        problem(409, 'workflow.tag_delete_overflow'),
      ),
      http.get(
        `${api}/workflow-tags/${secondWorkflowId}/workflows`,
        ({ request }) => {
          assignmentReads();
          const after = new URL(request.url).searchParams.get('after');
          return HttpResponse.json(
            after === null
              ? {
                  items: [{ workflowId, organizationRevision: 7 }],
                  nextCursor: cursor,
                }
              : {
                  items: [
                    { workflowId: secondWorkflowId, organizationRevision: 9 },
                  ],
                  nextCursor: null,
                },
          );
        },
      ),
      http.post(`${api}/workflow-tags/cleanup/detach`, async ({ request }) => {
        sent.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return HttpResponse.json({
          items: [
            {
              workflowId: secondWorkflowId,
              status: 'detached',
              organizationRevision: 10,
              replayed: true,
            },
            {
              workflowId,
              status: sent.length === 1 ? 'outcome_unknown' : 'not_visible',
            },
          ],
        });
      }),
    );
    renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    expect(
      within(confirmation).getByText(/including archived ones/),
    ).toBeInTheDocument();
    await event.click(
      within(confirmation).getByRole('button', { name: 'Delete tag' }),
    );
    await screen.findByText(/too many assignments/);
    await event.click(screen.getByRole('button', { name: 'Cancel' }));
    await event.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
    );
    await screen.findByRole('checkbox', {
      name: 'Select Alpha',
    });
    expect(assignmentReads).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole('checkbox', { name: /Select all/ }),
    ).not.toBeInTheDocument();
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await event.click(
      await screen.findByRole('checkbox', {
        name: 'Select Beta',
      }),
    );
    await event.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await event.click(
      screen.getByRole('button', {
        name: 'Detach tag from 2 selected workflows',
      }),
    );
    await screen.findByRole('button', { name: 'Retry exact command' });
    expect(
      screen.getByRole('checkbox', { name: 'Select Alpha' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(sent[0]?.body).toEqual({
      tagId: secondWorkflowId,
      items: [
        { workflowId: secondWorkflowId, expectedOrganizationRevision: 9 },
        { workflowId, expectedOrganizationRevision: 7 },
      ],
    });
    expect(
      within(screen.getByRole('region', { name: 'Tag cleanup' })).getByRole(
        'button',
        { name: 'Back to tags' },
      ),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Retry exact command' }),
    );
    await waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]).toEqual(sent[0]);
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Retry exact command' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 2 selected workflows',
      }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', {
        name: 'Reload assignments and clear selection',
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 0 selected workflows',
      }),
    ).toBeDisabled();
  });
  it('loads assignment pages only on request and caps explicit selection at 50', async () => {
    installVocabulary();
    const ids = Array.from(
      { length: 51 },
      (_, index) =>
        `${(index + 1).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    const reads = vi.fn();
    mockServer.use(
      http.get(`${api}/workflows/:id`, ({ params }) => {
        const index = ids.indexOf(String(params.id));
        return HttpResponse.json({
          workflow: summary(String(params.id), `Workflow ${String(index + 1)}`),
          organization: {
            tags: [],
            folderId: null,
            organizationRevision: 1,
            isFavorite: true,
          },
        });
      }),
      http.get(
        `${api}/workflow-tags/${secondWorkflowId}/workflows`,
        ({ request }) => {
          const after = new URL(request.url).searchParams.get('after');
          reads();
          let start = 50;
          if (after === null) start = 0;
          else if (after === cursor) start = 25;
          return HttpResponse.json({
            items: ids
              .slice(start, start + 25)
              .map((id) => ({ workflowId: id, organizationRevision: 1 })),
            nextCursor:
              new Map([
                [0, cursor],
                [25, 'opaque-page2'],
              ]).get(start) ?? null,
          });
        },
      ),
    );
    renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
    );
    const first = ids[0];
    const secondPage = ids[25];
    const last = ids[50];
    if (first === undefined || secondPage === undefined || last === undefined)
      throw new Error('Expected three fixture pages');
    await screen.findByRole('checkbox', { name: 'Select Workflow 1' });
    expect(reads).toHaveBeenCalledTimes(1);
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    await screen.findByRole('checkbox', {
      name: 'Select Workflow 26',
    });
    await event.click(
      screen.getByRole('button', { name: 'Load more assignments' }),
    );
    const overflow = await screen.findByRole('checkbox', {
      name: 'Select workflow name unavailable (51)',
    });
    // Wait for all bounded name reads once. These keyed controls stay mounted
    // during selection; rescanning the whole accessibility tree per click adds
    // avoidable quadratic work when the complete suite competes for CPU.
    const checkboxes = await waitFor(() => {
      const controls = screen.getAllByRole('checkbox', {
        name: /^Select Workflow \d+$/,
      });
      expect(controls).toHaveLength(50);
      return controls;
    });
    for (const [index, checkbox] of checkboxes.entries()) {
      expect(checkbox).toHaveAccessibleName(
        `Select Workflow ${String(index + 1)}`,
      );
      await event.click(checkbox);
      expect(checkbox).toBeChecked();
    }
    expect(overflow).toHaveAttribute('aria-disabled', 'true');
    await event.click(overflow);
    expect(overflow).not.toBeChecked();
    expect(
      screen.getByRole('button', {
        name: 'Detach tag from 50 selected workflows',
      }),
    ).toBeEnabled();
    expect(reads).toHaveBeenCalledTimes(3);
  });
});
