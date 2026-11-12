import { screen, waitFor } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { mockServer } from '../../support/mock-server';
import {
  captureCopies,
  created,
  identityUrl,
  nextTag,
  open,
  staleResponse,
  transient,
} from './duplicate-recovery/fixture';
import {
  api,
  draftBody,
  problem,
  versionId,
  workflowId,
} from './list/fixtures';

async function ready() {
  await screen.findByText(/last saved, revision 1/u);
}
async function editableFailure() {
  await screen.findByText(/couldn’t confirm that change/u);
  expect(screen.getByLabelText('Copy name')).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
}

describe('low-effect duplicate recovery', () => {
  it('does not read identity around source initialization', async () => {
    const { unmount } = open();
    let reads = 0;
    mockServer.use(
      http.get(identityUrl, () => {
        reads += 1;
        return HttpResponse.error();
      }),
    );
    await ready();
    unmount();
    expect(reads).toBe(0);
  });
  it.each([409, 412])(
    'keeps a copy editable after malformed POST %s details and uses a fresh key for every confirmation',
    async (status) => {
      const { event, onCreated } = open();
      const sent = captureCopies((count) => {
        if (count === 1) return HttpResponse.error();
        if (count === 2)
          return HttpResponse.json({ malformed: true }, { status });
        return created();
      });
      await ready();
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await editableFailure();
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await waitFor(() => {
        expect(sent).toHaveLength(2);
      });
      await editableFailure();
      expect(onCreated).not.toHaveBeenCalled();
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(new Set(sent.map((item) => item.key)).size).toBe(3);
      expect(sent.map((item) => item.body)).toEqual([
        sent[0]?.body,
        sent[0]?.body,
        sent[0]?.body,
      ]);
      expect(sent.map((item) => item.tag)).toEqual([
        sent[0]?.tag,
        sent[0]?.tag,
        sent[0]?.tag,
      ]);
    },
  );
  it('keeps the copy name after a definitive conflict and permits a fresh confirmation', async () => {
    const { event, onCreated } = open();
    const sent = captureCopies((count) =>
      count === 1 ? problem(409, 'request.idempotency_conflict') : created(),
    );
    await ready();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await screen.findByText(/already used with different details/u);
    expect(screen.getByLabelText('Copy name')).toHaveValue('Source (copy)');
    expect(onCreated).not.toHaveBeenCalled();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
    });
    expect(sent[0]?.key).not.toBe(sent[1]?.key);
  });
  it('requires reading the changed saved source before confirming a new copy, preserving its name', async () => {
    const { event, onCreated } = open();
    const sent = captureCopies((count) =>
      count === 1 ? staleResponse() : created(),
    );
    await ready();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await screen.findByText(/The saved source changed/u);
    expect(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Copy name')).toHaveValue('Source (copy)');
    mockServer.use(
      http.get(`${api}/workflows/${workflowId}/draft`, () =>
        HttpResponse.json(
          { ...draftBody(workflowId), revision: 2 },
          { headers: { etag: nextTag } },
        ),
      ),
    );
    await event.click(
      screen.getByRole('button', { name: 'Read current saved draft' }),
    );
    await screen.findByText(/last saved, revision 2/u);
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.tag).toBe(nextTag);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
  });
  it.each([429, 503])(
    'refreshes after POST %i and leaves a new confirmation to the user',
    async (status) => {
      const { event, onCreated } = open();
      const sent = captureCopies((count) =>
        count === 1 ? transient(status) : created(),
      );
      await ready();
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Duplicate workflow' }),
        ).toBeEnabled(),
      );
      expect(sent).toHaveLength(1);
      expect(onCreated).not.toHaveBeenCalled();
      await event.clear(screen.getByLabelText('Copy name'));
      await event.type(screen.getByLabelText('Copy name'), 'Reviewed copy');
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(sent[1]?.body).toEqual({
        name: 'Reviewed copy',
        source: { kind: 'draft' },
      });
      expect(sent[1]?.key).not.toBe(sent[0]?.key);
    },
  );
  it('does not deliver a late accepted copy to an unmounted dialog', async () => {
    const { event, onCreated, unmount } = open();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    let writes = 0;
    mockServer.use(
      http.post(`${api}/workflows/${workflowId}/duplicate`, async () => {
        writes += 1;
        await held;
        return created();
      }),
    );
    await ready();
    await event.click(
      screen.getByRole('button', { name: 'Duplicate workflow' }),
    );
    await waitFor(() => {
      expect(writes).toBe(1);
    });
    unmount();
    release();
    await held;
    await Promise.resolve();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
