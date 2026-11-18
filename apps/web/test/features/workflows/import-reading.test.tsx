import { act, screen } from '@testing-library/react';
import { expect, describe, it } from 'vitest';
import { manifest, mountList } from './import-recovery/fixture';

const invalidJson =
  'This file isn’t valid JSON. Choose a workflow file exported from Pertexo.';

// A file whose bytes arrive only when the test releases them.
function heldFile(contents: string, name: string) {
  let release!: () => Promise<void>;
  const bytes = new Promise<ArrayBuffer>((resolve) => {
    release = async () => {
      resolve(new TextEncoder().encode(contents).buffer);
      await bytes;
    };
  });
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(file, 'arrayBuffer', { value: () => bytes });
  return { file, release: () => act(release) };
}

function readyFile(contents: string, name: string) {
  const file = new File([contents], name, { type: 'application/json' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: () => Promise.resolve(new TextEncoder().encode(contents).buffer),
  });
  return file;
}

describe('Reading a chosen workflow file', () => {
  it('finishes reading a chosen file while its new workflow name is edited', async () => {
    const { event } = mountList();
    await event.click(
      await screen.findByRole('button', { name: 'Import workflow…' }),
    );
    const held = heldFile(JSON.stringify(manifest), 'portable.json');
    await event.upload(
      await screen.findByLabelText('Workflow JSON file'),
      held.file,
    );
    await event.type(
      screen.getByLabelText('New workflow name'),
      'My imported workflow',
    );
    await held.release();
    expect(
      await screen.findByLabelText('Complete imported graph'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'My imported workflow',
    );
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeEnabled();
  });

  it('shows a file failure after the name changes and permits choosing another file', async () => {
    const { event } = mountList();
    await event.click(
      await screen.findByRole('button', { name: 'Import workflow…' }),
    );
    const held = heldFile('invalid', 'invalid.json');
    await event.upload(screen.getByLabelText('Workflow JSON file'), held.file);
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Retained name',
    );
    await held.release();
    expect(await screen.findByText(invalidJson)).toBeVisible();
    expect(screen.getByLabelText('New workflow name')).toHaveValue(
      'Retained name',
    );
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeDisabled();
    await event.upload(
      screen.getByLabelText('Workflow JSON file'),
      readyFile(JSON.stringify(manifest), 'fixed.json'),
    );
    await screen.findByLabelText('Complete imported graph');
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeEnabled();
  });

  it('keeps the second chosen file when the first file finishes later', async () => {
    const { event } = mountList();
    await event.click(
      await screen.findByRole('button', { name: 'Import workflow…' }),
    );
    const first = heldFile('invalid', 'old.json');
    await event.upload(screen.getByLabelText('Workflow JSON file'), first.file);
    await event.upload(
      screen.getByLabelText('Workflow JSON file'),
      readyFile(JSON.stringify(manifest), 'current.json'),
    );
    await screen.findByLabelText('Complete imported graph');
    await first.release();
    expect(
      screen.getByLabelText('Complete imported graph'),
    ).toBeInTheDocument();
    expect(screen.queryByText(invalidJson)).not.toBeInTheDocument();
    await event.type(
      screen.getByLabelText('New workflow name'),
      'Current import',
    );
    expect(
      screen.getByRole('button', { name: 'Preview import' }),
    ).toBeEnabled();
  });
});
