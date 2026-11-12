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
/** An unconfirmed copy offers its safe retry and can't be dropped by closing. */
async function unconfirmedCopy() {
  await screen.findByText(/couldn’t confirm whether the copy was made/u);
  expect(
    screen.getByRole('button', { name: 'Retry exact copy' }),
  ).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
}

describe('duplicate recovery', () => {
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
    'keeps one key for an unconfirmed copy through malformed POST %s details',
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
      await unconfirmedCopy();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(sent).toHaveLength(2);
      });
      await unconfirmedCopy();
      expect(onCreated).not.toHaveBeenCalled();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(sent).toHaveLength(3);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[2]).toEqual(sent[0]);
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
    'keeps a lost copy’s key across a recovery POST %s',
    async (status) => {
      const { event, onCreated } = open();
      const sent = captureCopies((count) => {
        if (count === 1) return HttpResponse.error();
        if (count === 2)
          return status === 429
            ? problem(429, 'request.rate_limited')
            : transient(status);
        return created();
      });
      await ready();
      await event.click(
        screen.getByRole('button', { name: 'Duplicate workflow' }),
      );
      await unconfirmedCopy();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(sent).toHaveLength(2);
      });
      // A throttled or unavailable retry says nothing about the lost send.
      await unconfirmedCopy();
      expect(onCreated).not.toHaveBeenCalled();
      await event.click(
        screen.getByRole('button', { name: 'Retry exact copy' }),
      );
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledExactlyOnceWith(versionId);
      });
      expect(sent).toHaveLength(3);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[2]).toEqual(sent[0]);
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
