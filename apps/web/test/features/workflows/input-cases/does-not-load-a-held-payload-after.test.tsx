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
  it('admits only one user double-click save and keeps the form editable after failure', async () => {
    const captures: unknown[] = [];
    let release!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    mockServer.use(
      http.put(`${path}/${caseId}`, async ({ request }) => {
        captures.push(await request.json());
        await pending;
        return HttpResponse.error();
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'Edit Synthetic customer' }),
    );
    const save = await screen.findByRole('button', { name: 'Save input case' });
    await event.dblClick(save);
    expect(captures).toHaveLength(1);
    expect(screen.getByLabelText('Case name')).toBeDisabled();
    release();
    await screen.findByText(/Check the refreshed current state/u);
    expect(captures).toEqual([
      {
        name: metadata.name,
        input: { customer: 'synthetic' },
        expectations: { outcome: 'succeeds', assertions: [] },
      },
    ]);
    expect(screen.getByLabelText('Case name')).toBeEnabled();
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
  it('keeps edits and the opaque tag after a lost update and uses a fresh key for a new confirmation', async () => {
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
    await screen.findByText(/Check the refreshed current state/u);
    expect(screen.getByLabelText('Case input (JSON)')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Cancel case edit' }),
    ).toBeEnabled();
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await waitFor(() => {
      expect(writes).toHaveLength(2);
    });
    expect(writes[1]?.body).toEqual(writes[0]?.body);
    expect(writes[1]?.tag).toBe(writes[0]?.tag);
    expect(writes[1]?.key).not.toBe(writes[0]?.key);
  });
  it('keeps one key for an unchanged case create after a lost response and a new key once it changes', async () => {
    const creates: { body: unknown; key: string | null }[] = [];
    mockServer.use(
      http.post(path, async ({ request }) => {
        creates.push({
          body: await request.json(),
          key: request.headers.get('idempotency-key'),
        });
        return creates.length < 3
          ? HttpResponse.error()
          : HttpResponse.json(
              { caseId, revision: 1, replayed: false },
              { status: 201 },
            );
      }),
    );
    const { event } = open();
    await event.click(
      await screen.findByRole('button', { name: 'New input case' }),
    );
    await event.type(await screen.findByLabelText('Case name'), 'Lost case');
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await screen.findByText(/couldn’t confirm whether the case was saved/u);
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await waitFor(() => {
      expect(creates).toHaveLength(2);
    });
    await screen.findByText(/couldn’t confirm whether the case was saved/u);
    expect(creates[1]).toEqual(creates[0]);
    await event.type(screen.getByLabelText('Case name'), ' renamed');
    await event.click(screen.getByRole('button', { name: 'Save input case' }));
    await waitFor(() => {
      expect(creates).toHaveLength(3);
    });
    expect(creates[2]?.body).toMatchObject({ name: 'Lost case renamed' });
    expect(creates[2]?.key).toBeTruthy();
    expect(creates[2]?.key).not.toBe(creates[0]?.key);
  });
});
