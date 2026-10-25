import { workflowOrganizationKeys } from '@/features/workflows/data/organization/queries';

import { act, screen, waitFor, within } from '@testing-library/react';

import userEvent from '@testing-library/user-event';

import { HttpResponse, http } from 'msw';

import { describe, expect, it, vi } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import {
  api,
  problem,
  secondWorkflowId,
  userId,
  workflowId,
  workspaceId,
} from '../list/fixtures';

import { installVocabulary, renderTags, tag } from './tags/fixture';

describe('workflow tags dialog', () => {
  it('lets a completed add tag stay out of a later deletion confirmation', async () => {
    installVocabulary();
    const deleted = vi.fn();
    mockServer.use(
      http.post(`${api}/workflow-tags`, () =>
        HttpResponse.json({ tag, replayed: false }),
      ),
      http.post(`${api}/workflow-tags/${tag.id}/delete`, () => {
        deleted();
        return HttpResponse.json({ deleted: true, replayed: false });
      }),
    );
    renderTags();
    const event = userEvent.setup();
    await screen.findByRole('button', { name: 'ops' });
    await event.type(screen.getByLabelText('New tag'), 'new-tag');
    await event.click(screen.getByRole('button', { name: 'Add tag' }));
    await screen.findByText('Tag added');
    await event.click(screen.getByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    const confirm = within(confirmation).getByRole('button', {
      name: 'Delete tag',
    });
    expect(confirm).toBeEnabled();
    expect(deleted).not.toHaveBeenCalled();
    await event.click(confirm);
    await waitFor(() => {
      expect(deleted).toHaveBeenCalledTimes(1);
    });
  });
  it('binds deletion to the tag as shown across a background rename, then reloads explicitly', async () => {
    installVocabulary();
    let renamed = false;
    const nextTag = { ...tag, key: 'renamed-ops', revision: 9 };
    const bodies: unknown[] = [];
    mockServer.use(
      http.get(`${api}/workflow-tags`, () =>
        HttpResponse.json({
          items: [renamed ? nextTag : tag],
          nextCursor: null,
        }),
      ),
      http.post(
        `${api}/workflow-tags/${tag.id}/delete`,
        async ({ request }) => {
          bodies.push(await request.json());
          return bodies.length === 1
            ? problem(409, 'workflow.tag_revision_conflict')
            : HttpResponse.json({ deleted: true, replayed: false });
        },
      ),
    );
    const { queryClient } = renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    renamed = true;
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: workflowOrganizationKeys.tags(userId, workspaceId),
      });
    });
    const confirmation = screen.getByRole('dialog', { name: 'Delete #ops?' });
    await event.click(
      within(confirmation).getByRole('button', { name: 'Delete tag' }),
    );
    await screen.findAllByText(
      'This tag changed. Refresh it before trying again.',
    );
    expect(bodies).toEqual([{ expectedTagRevision: tag.revision }]);
    await event.click(
      within(confirmation).getByRole('button', { name: 'Cancel' }),
    );
    await event.click(screen.getByRole('button', { name: 'Reload tags' }));
    // The same tag stays chosen, now with its current name.
    expect(await screen.findByLabelText('Rename #renamed-ops')).toBeVisible();
    await event.click(screen.getByRole('button', { name: 'Delete tag' }));
    await event.click(
      within(
        screen.getByRole('dialog', { name: 'Delete #renamed-ops?' }),
      ).getByRole('button', { name: 'Delete tag' }),
    );
    await waitFor(() => {
      expect(bodies).toHaveLength(2);
    });
    expect(bodies[1]).toEqual({ expectedTagRevision: nextTag.revision });
  });
  it('associates tag validation and focuses the field only on submit', async () => {
    installVocabulary();
    renderTags();
    await screen.findByRole('button', { name: 'ops' });
    const field = screen.getByLabelText('New tag');
    await userEvent.type(field, 'bad.key');
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Add tag' }));
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByText(/Use up to 32 characters/);
    expect(field.getAttribute('aria-describedby')).toContain(error.id);
    await userEvent.clear(field);
    await userEvent.type(field, 'valid');
    expect(field).not.toHaveAttribute('aria-invalid', 'true');
  });
  it.each(['builder', 'viewer'] as const)(
    'does not read or show tag controls for %s',
    async (role) => {
      const read = vi.fn();
      mockServer.use(
        http.get(`${api}/workflow-tags`, () => {
          read();
          return HttpResponse.json({ items: [], nextCursor: null });
        }),
      );
      const { onClose } = renderTags(role);
      expect(screen.getByText(/Only owners and admins/)).toBeVisible();
      expect(read).not.toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(onClose).toHaveBeenCalled();
    },
  );
  it('hides tag controls after a denied write and still allows closing', async () => {
    installVocabulary();
    mockServer.use(
      http.post(`${api}/workflow-tags/${tag.id}/rename`, () =>
        problem(403, 'request.forbidden'),
      ),
    );
    const { onClose } = renderTags();
    const event = userEvent.setup();
    await event.click(await screen.findByRole('button', { name: 'ops' }));
    await event.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText(/Your access changed/);
    expect(
      screen.queryByRole('button', { name: 'ops' }),
    ).not.toBeInTheDocument();
    await event.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('uses an unavailable ordinal instead of leaking IDs or stale names for an invisible assignment', async () => {
    installVocabulary();
    mockServer.use(
      http.get(`${api}/workflow-tags/${secondWorkflowId}/workflows`, () =>
        HttpResponse.json({
          items: [{ workflowId, organizationRevision: 7 }],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/workflows/${workflowId}`, () =>
        problem(404, 'workflow.not_found'),
      ),
    );
    const { queryClient } = renderTags();
    await userEvent.click(await screen.findByRole('button', { name: 'ops' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
    );
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Select workflow name unavailable (1)',
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData([
          'identity',
          userId,
          'workspace',
          workspaceId,
          'workflow-organization',
          'labels',
          workflowId,
        ]),
      ).toBeNull();
    });
    expect(checkbox).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });
  it('retires cleanup controls and names when a projection name read loses permission', async () => {
    installVocabulary();
    mockServer.use(
      http.get(`${api}/workflow-tags/${secondWorkflowId}/workflows`, () =>
        HttpResponse.json({
          items: [{ workflowId, organizationRevision: 7 }],
          nextCursor: null,
        }),
      ),
      http.get(`${api}/workflows/${workflowId}`, () =>
        problem(403, 'request.forbidden'),
      ),
    );
    renderTags();
    await userEvent.click(await screen.findByRole('button', { name: 'ops' }));
    await userEvent.click(
      screen.getByRole('button', { name: 'See workflows using it' }),
    );
    await screen.findByText(/Your access changed/);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    expect(
      screen.queryByText(workflowId, { exact: false }),
    ).not.toBeInTheDocument();
  });
});
