import { setup, file, scope, artifactId, bytes } from './upload.fixture';
import { webcrypto } from 'node:crypto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UploadFile } from '@/features/artifacts/public';

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(onUse = vi.fn()) {
  const view = render(
    <UploadFile
      targetKey="body-1"
      scope={scope}
      description="Send exact file bytes."
      onUse={onUse}
    />,
  );
  const event = userEvent.setup();
  const opener = screen.getByRole('button', { name: 'Upload file' });
  await event.click(opener);
  return { event, onUse, view, opener };
}

it('finalizes opaque bytes before inserting only the descriptor, without application credentials', async () => {
  const calls = setup();
  const { event, onUse } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await screen.findByText('File ready');
  expect(onUse).not.toHaveBeenCalled();
  expect(screen.getByText(/opaque.bin/)).toHaveTextContent('4 B');
  await event.click(screen.getByRole('button', { name: 'Use file' }));
  await waitFor(() => {
    expect(onUse).toHaveBeenCalledTimes(1);
  });
  expect(onUse.mock.calls[0]?.[0]).toEqual({
    kind: 'artifact',
    artifactId,
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: calls.metadata('available').sha256,
  });
  expect(calls.counts()).toEqual({ puts: 1, finalizes: 1 });
});

it('reconciles a lost PUT reply using the same identity before sending bytes again', async () => {
  const calls = setup({ lostPut: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await event.click(
    await screen.findByRole('button', { name: 'Check and retry same file' }),
  );
  await screen.findByText('File ready');
  expect(calls.keys).toHaveLength(1);
  expect(calls.counts()).toEqual({ puts: 1, finalizes: 1 });
});

it('rejects one byte over the consumer budget without reading or reserving', async () => {
  const calls = setup();
  const { event, onUse } = await open();
  const selected = file(1024 * 1024 + 1);
  const read = vi.spyOn(selected, 'arrayBuffer');
  await event.upload(screen.getByLabelText('File', { exact: true }), selected);
  await screen.findByText('Choose a file no larger than 1 MB.');
  expect(read).not.toHaveBeenCalled();
  expect(calls.keys).toHaveLength(0);
  expect(onUse).not.toHaveBeenCalled();
});

it('explains disabled storage without claiming a role change', async () => {
  setup({ unavailable: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  expect(await screen.findByText(/ARTIFACT_STORE_\*/)).toBeInTheDocument();
  expect(
    screen.queryByText(/role.*changed|no longer.*access/u),
  ).not.toBeInTheDocument();
});

it('cancels hashing and prevents a late result from reserving or attaching', async () => {
  const calls = setup();
  const { event, onUse } = await open();
  let finish: ((value: ArrayBuffer) => void) | undefined;
  const selected = file();
  Object.defineProperty(selected, 'arrayBuffer', {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await event.upload(screen.getByLabelText('File', { exact: true }), selected);
  await event.click(screen.getByRole('button', { name: 'Cancel upload' }));
  finish?.(bytes.slice().buffer);
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(calls.keys).toHaveLength(0);
  expect(onUse).not.toHaveBeenCalled();
});

it('reuses the reservation key when admission committed but its reply was lost', async () => {
  const calls = setup({ lostBegin: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await event.click(
    await screen.findByRole('button', { name: 'Check and retry same file' }),
  );
  await screen.findByText('File ready');
  expect(calls.keys).toHaveLength(2);
  expect(calls.keys[0]).toBe(calls.keys[1]);
  expect(calls.counts()).toEqual({ puts: 1, finalizes: 1 });
});

it('checks finalized metadata after a lost finalization reply, without another upload', async () => {
  const calls = setup({ lostFinalize: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await event.click(
    await screen.findByRole('button', { name: 'Check and retry same file' }),
  );
  await screen.findByText('File ready');
  expect(calls.keys).toHaveLength(1);
  expect(calls.counts()).toEqual({ puts: 1, finalizes: 1 });
});

it('refreshes the same pending reservation only after reconciliation cannot finalize its missing bytes', async () => {
  const calls = setup({ missingPut: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await event.click(
    await screen.findByRole('button', { name: 'Check and retry same file' }),
  );
  await screen.findByText('File ready');
  expect(calls.keys).toHaveLength(2);
  expect(calls.keys[0]).toBe(calls.keys[1]);
  expect(calls.counts()).toEqual({ puts: 2, finalizes: 2 });
});

it('aborts and fences the selected file when the signed-in identity changes', async () => {
  const calls = setup();
  const { event, onUse, view } = await open();
  let finish: ((value: ArrayBuffer) => void) | undefined;
  const selected = file();
  Object.defineProperty(selected, 'arrayBuffer', {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await event.upload(screen.getByLabelText('File', { exact: true }), selected);
  view.rerender(
    <UploadFile
      targetKey="body-1"
      scope={{ ...scope, userId: 'another-person' }}
      description="Send exact file bytes."
      onUse={onUse}
    />,
  );
  finish?.(bytes.slice().buffer);
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(calls.keys).toHaveLength(0);
  expect(onUse).not.toHaveBeenCalled();
});

it('cancels a changed mapping target without replacing its keyboard opener', async () => {
  const calls = setup();
  const { event, onUse, view, opener } = await open();
  let finish: ((value: ArrayBuffer) => void) | undefined;
  const selected = file();
  Object.defineProperty(selected, 'arrayBuffer', {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await event.upload(screen.getByLabelText('File', { exact: true }), selected);
  view.rerender(
    <UploadFile
      targetKey="body-2"
      scope={scope}
      description="Send exact file bytes."
      onUse={onUse}
    />,
  );
  finish?.(bytes.slice().buffer);
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(screen.getByRole('button', { name: 'Upload file' })).toBe(opener);
  expect(calls.keys).toHaveLength(0);
  expect(onUse).not.toHaveBeenCalled();
});

it('does not invoke insertion if its target changes before the queued callback starts', async () => {
  setup();
  const { event, onUse, view } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  await screen.findByText('File ready');
  fireEvent.click(screen.getByRole('button', { name: 'Use file' }));
  view.rerender(
    <UploadFile
      targetKey="body-2"
      scope={scope}
      description="Send exact file bytes."
      onUse={onUse}
    />,
  );
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  expect(onUse).not.toHaveBeenCalled();
});
