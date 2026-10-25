import { describeUpload } from '@/features/artifacts/model/upload';
import { UploadFile } from '@/features/artifacts/public';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createHash, webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { artifactId, bytes, file, scope, setup } from './upload.fixture';

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

it.each([
  {
    name: 'reconciles a lost PUT reply using the same identity before sending bytes again',
    options: { lostPut: true },
  },
  {
    name: 'checks finalized metadata after a lost finalization reply, without another upload',
    options: { lostFinalize: true },
  },
])('$name', async ({ options }) => {
  const calls = setup(options);
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
  const selected = file(10 * 1024 * 1024 + 1);
  const read = vi.spyOn(selected, 'arrayBuffer');
  await event.upload(screen.getByLabelText('File', { exact: true }), selected);
  await screen.findByText(
    'Choose a file no larger than 10 MB. Split larger files into smaller files and upload them separately.',
  );
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

it('hashes exactly ten MiB and wipes its owned buffer before returning upload metadata', async () => {
  const selected = file(10485760);
  const owned = await selected.arrayBuffer();
  const expected = createHash('sha256')
    .update(new Uint8Array(owned))
    .digest('hex');
  vi.spyOn(selected, 'arrayBuffer').mockResolvedValue(owned);
  const result = await describeUpload(selected, new AbortController().signal);
  expect(result).toMatchObject({ byteLength: 10485760, sha256: expected });
  expect(new Uint8Array(owned).every((byte) => byte === 0)).toBe(true);
});

it('explains a lower server storage limit without retrying an unchanged oversized file', async () => {
  const calls = setup({ tooLarge: true });
  const { event } = await open();
  await event.upload(screen.getByLabelText('File', { exact: true }), file());
  expect(
    await screen.findByText(/file exceeds the server’s storage limit/u),
  ).toHaveTextContent('Split it into smaller files');
  expect(calls.counts()).toEqual({ puts: 0, finalizes: 0 });
});
