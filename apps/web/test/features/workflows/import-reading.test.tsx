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
