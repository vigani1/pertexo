import { act, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { manifest, mountList } from './import-recovery/fixture';

it('finishes reading a chosen file while its new workflow name is edited', async () => {
  const { event } = mountList();
  await event.click(
    await screen.findByRole('button', { name: 'Import workflow…' }),
  );
  let release: ((value: ArrayBuffer) => void) | undefined;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const file = new File([JSON.stringify(manifest)], 'portable.json', {
    type: 'application/json',
  });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  await event.upload(await screen.findByLabelText('Workflow JSON file'), file);
  await event.type(
    screen.getByLabelText('New workflow name'),
    'My imported workflow',
  );
  await act(async () => {
    release?.(new TextEncoder().encode(JSON.stringify(manifest)).buffer);
    await bytes;
  });
  expect(
    await screen.findByLabelText('Complete imported graph'),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('New workflow name')).toHaveValue(
    'My imported workflow',
  );
  expect(screen.getByRole('button', { name: 'Preview import' })).toBeEnabled();
});

it('shows a file failure after the name changes and permits choosing another file', async () => {
  const { event } = mountList();
  await event.click(
    await screen.findByRole('button', { name: 'Import workflow…' }),
  );
  let release!: (value: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const file = new File(['invalid'], 'invalid.json', {
    type: 'application/json',
  });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  await event.upload(screen.getByLabelText('Workflow JSON file'), file);
  await event.type(screen.getByLabelText('New workflow name'), 'Retained name');
  await act(async () => {
    release(new TextEncoder().encode('invalid').buffer);
    await bytes;
  });
  expect(
    await screen.findByText(
      'This file isn’t valid JSON. Choose a workflow file exported from Pertexo.',
    ),
  ).toBeVisible();
  expect(screen.getByLabelText('New workflow name')).toHaveValue(
    'Retained name',
  );
  expect(screen.getByRole('button', { name: 'Preview import' })).toBeDisabled();
  const replacement = new File([JSON.stringify(manifest)], 'fixed.json', {
    type: 'application/json',
  });
  Object.defineProperty(replacement, 'arrayBuffer', {
    value: () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(manifest)).buffer,
      ),
  });
  await event.upload(screen.getByLabelText('Workflow JSON file'), replacement);
  await screen.findByLabelText('Complete imported graph');
  expect(screen.getByRole('button', { name: 'Preview import' })).toBeEnabled();
});

it('keeps the second chosen file when the first file finishes later', async () => {
  const { event } = mountList();
  await event.click(
    await screen.findByRole('button', { name: 'Import workflow…' }),
  );
  let release!: (value: ArrayBuffer) => void;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    release = resolve;
  });
  const first = new File(['invalid'], 'old.json', { type: 'application/json' });
  Object.defineProperty(first, 'arrayBuffer', { value: () => bytes });
  await event.upload(screen.getByLabelText('Workflow JSON file'), first);
  const second = new File([JSON.stringify(manifest)], 'current.json', {
    type: 'application/json',
  });
  Object.defineProperty(second, 'arrayBuffer', {
    value: () =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(manifest)).buffer,
      ),
  });
  await event.upload(screen.getByLabelText('Workflow JSON file'), second);
  await screen.findByLabelText('Complete imported graph');
  await act(async () => {
    release(new TextEncoder().encode('invalid').buffer);
    await bytes;
  });
  expect(screen.getByLabelText('Complete imported graph')).toBeInTheDocument();
  expect(
    screen.queryByText(
      'This file isn’t valid JSON. Choose a workflow file exported from Pertexo.',
    ),
  ).not.toBeInTheDocument();
  await event.type(
    screen.getByLabelText('New workflow name'),
    'Current import',
  );
  expect(screen.getByRole('button', { name: 'Preview import' })).toBeEnabled();
});
