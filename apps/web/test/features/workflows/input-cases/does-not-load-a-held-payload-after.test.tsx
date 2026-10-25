import { act, screen, waitFor } from '@testing-library/react';

import { http, HttpResponse } from 'msw';

import { describe, expect, it } from 'vitest';

import { mockServer } from '../../../support/mock-server';

import { caseId, metadata, open, path } from './fixture';

import { problem, versionId } from '../list/fixtures';

describe('shared workflow input cases', () => {
  it('does not load a held payload after its component owner is disposed', async () => {
    const { event, onLoad, unmount } = open(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    mockServer.use(
      http.get(`${path}/${caseId}`, async () => {
        started = true;
        await held;
        return HttpResponse.json({
          case: { ...metadata, input: { private: 'old owner payload' } },
        });
      }),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await waitFor(() => {
      expect(started).toBe(true);
    });
    unmount();
    release();
    await held;
    expect(onLoad).not.toHaveBeenCalled();
  });
  it('hides cached metadata and payload controls after an actual case-read denial', async () => {
    const { event, onLoad } = open(false);
    mockServer.use(
      http.get(`${path}/${caseId}`, () => problem(403, 'auth.forbidden')),
    );
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await screen.findByText('Access to input cases is no longer available.');
    expect(
      screen.queryByRole('button', { name: 'Load Synthetic customer' }),
    ).not.toBeInTheDocument();
    expect(onLoad).not.toHaveBeenCalled();
  });
  it('lets operators load a detached input without CRUD or execution', async () => {
    const { event, onLoad } = open(false);
    await event.click(
      await screen.findByRole('button', { name: 'Load Synthetic customer' }),
    );
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledOnce();
    });
    expect(onLoad).toHaveBeenCalledWith({
      name: metadata.name,
      workflowVersionId: versionId,
      input: { customer: 'synthetic' },
    });
    expect(
      screen.queryByRole('button', { name: 'New input case' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit Synthetic customer' }),
    ).not.toBeInTheDocument();
  });
  it('admits only one same-tick payload read and unlocks after failure', async () => {
    const { event, onLoad } = open(false);
    let reads = 0;
    mockServer.use(
      http.get(`${path}/${caseId}`, () => {
        reads += 1;
        return reads === 1
          ? HttpResponse.error()
          : HttpResponse.json(
              {
                case: { ...metadata, input: { nested: { value: 'original' } } },
              },
              { headers: { ETag: metadata.representationTag } },
            );
      }),
    );
    const load = await screen.findByRole('button', {
      name: 'Load Synthetic customer',
    });
    act(() => {
      load.click();
      load.click();
    });
    await screen.findByRole('alert');
    expect(reads).toBe(1);
    await waitFor(() => expect(load).toBeEnabled());
    await event.click(load);
    await waitFor(() => {
      expect(onLoad).toHaveBeenCalledOnce();
    });
    expect(reads).toBe(2);
  });
  it('admits only one same-tick save while preserving the exact recovery command', async () => {
    const captures: unknown[] = [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        captures.push(await request.json());
        return HttpResponse.error();
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    const save = await screen.findByRole('button', { name: 'Save input case' });
    act(() => {
      save.click();
      save.click();
    });
    await screen.findByRole('button', { name: 'Retry exact case change' });
    expect(captures).toEqual([
      {
        name: metadata.name,
        input: { customer: 'synthetic' },
        expectations: { outcome: 'succeeds', assertions: [] },
      },
    ]);
    expect(screen.getByLabelText('Case name')).toBeDisabled();
  });
  it('keeps case edits on a typed conflict and requires explicit current-read review', async () => {
    const writes: { body: unknown; tag: string | null; key: string | null }[] =
      [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        writes.push({
          body: await request.json(),
          tag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        return problem(412, 'workflow.input_case_revision_conflict');
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    const input = await screen.findByLabelText('Case input (JSON)');
    await event.clear(input);
    await event.type(input, '{{"customer":"changed"}', { skipClick: true });
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await screen.findByText(/This case changed elsewhere/u);
    expect(input).toHaveValue('{"customer":"changed"}');
    expect(writes[0]?.body).toEqual({
      name: metadata.name,
      input: { customer: 'changed' },
      expectations: { outcome: 'succeeds', assertions: [] },
    });
    expect(writes[0]?.tag).toBe(metadata.representationTag);
    expect(
      screen.getByRole('button', { name: 'Save input case' }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Read current case; keep my edits' }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save input case' }),
      ).toBeEnabled(),
    );
    expect(input).toHaveValue('{"customer":"changed"}');
  });
  it('retries a lost update with the same body, opaque tag and key', async () => {
    const writes: { body: unknown; tag: string | null; key: string | null }[] =
      [];
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        writes.push({
          body: await request.json(),
          tag: request.headers.get('if-match'),
          key: request.headers.get('idempotency-key'),
        });
        return writes.length === 1
          ? HttpResponse.error()
          : HttpResponse.json({ caseId, revision: 2, replayed: true });
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    await screen.findByLabelText('Case name');
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await screen.findByRole('button', { name: 'Retry exact case change' });
    expect(screen.getByLabelText('Case input (JSON)')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Cancel case edit' }),
    ).toBeDisabled();
    await event.click(
      screen.getByRole('button', { name: 'Retry exact case change' }),
    );
    await waitFor(() => {
      expect(writes).toHaveLength(2);
    });
    expect(writes[1]).toEqual(writes[0]);
  });
});
